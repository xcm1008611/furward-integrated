import asyncio
import inspect
from contextlib import suppress
from time import time
from typing import Callable

from app.config import Settings
from app.errors import ApiError, INVALID_ARGS, ROBOT_BUSY, ROBOT_OFFLINE
from app.events import EventBus
from app.models import Command, Task, TaskStatus
from app.robot.gateway import RobotGateway
from app.services.commands import estimate_duration, validate_command
from app.services.modes import ModeService


class Scheduler:
    def __init__(self, gateway: RobotGateway, modes: ModeService, settings: Settings, bus: EventBus):
        self.gateway, self.modes, self.settings, self.bus = gateway, modes, settings, bus
        self.reserved_source: str | None = None
        self._current: Task | None = None
        self._runner: asyncio.Task | None = None
        self._listeners: list[Callable] = []
        self._stop_listeners: list[Callable] = []
        self._stop_lock = asyncio.Lock()
        self._notified: str | None = None
        modes.is_busy = lambda: self.busy

    @property
    def busy(self) -> bool:
        return self._stop_lock.locked() or (self._current is not None and self._current.status in {TaskStatus.QUEUED, TaskStatus.RUNNING})

    def current(self) -> Task | None:
        return self._current.model_copy(deep=True) if self._current else None

    def add_listener(self, callback: Callable):
        self._listeners.append(callback)

    def add_stop_listener(self, callback: Callable):
        self._stop_listeners.append(callback)

    async def _update(self, task: Task):
        task.updated_at = time()
        await self.bus.publish('task.update', task.model_dump(mode='json'))

    async def _notify(self, task: Task):
        if self._notified == task.id:
            return
        self._notified = task.id
        for callback in self._listeners:
            try:
                result = callback(task.model_copy(deep=True))
                if inspect.isawaitable(result):
                    await result
            except Exception:
                await self.bus.log('error', '任务结束回调执行失败', task_id=task.id)

    async def require_online(self):
        state = await self.gateway.get_state()
        if not state.online:
            raise ApiError(ROBOT_OFFLINE, '机器狗未连接', 503)
        return state

    async def submit(self, name: str, steps: list[Command], source: str = 'api') -> Task:
        commands = [validate_command(step, self.modes.mode, self.settings) for step in steps]
        if not commands:
            raise ApiError(INVALID_ARGS, '任务至少需要一条命令')
        # 停止不能藏在普通序列里等待前面的动作执行。
        if any(cmd.name == 'stop' for cmd in commands):
            if len(commands) != 1:
                raise ApiError(INVALID_ARGS, '停止命令必须单独提交')
            await self.stop()
            task = Task(name=name, steps=commands, source=source, status=TaskStatus.DONE)
            await self._update(task)
            await self._notify(task)
            return task
        await self.require_online()
        if self.busy or (self.reserved_source is not None and source != self.reserved_source):
            raise ApiError(ROBOT_BUSY, '已有任务正在执行', 409)
        task = Task(name=name, steps=commands, source=source)
        self._current = task
        await self._update(task)
        self._runner = asyncio.create_task(self._run(task))
        return task.model_copy(deep=True)

    async def wait(self, task_id: str) -> Task:
        task, runner = self._current, self._runner
        if task is None or task.id != task_id:
            raise ApiError(INVALID_ARGS, '任务已被替换')
        if runner:
            await asyncio.wait({runner})
        return task.model_copy(deep=True)

    async def _run(self, task: Task):
        try:
            task.status = TaskStatus.RUNNING
            for index, cmd in enumerate(task.steps):
                task.current_step = index
                task.step_started_at = time()
                await self._update(task)
                timeout = max(self.settings.cmd_deadline_s, estimate_duration(cmd, self.settings) * 2)
                if self.settings.robot_backend == 'bridge':
                    timeout = max(timeout, self.settings.cmd_deadline_s + 3)
                result = await asyncio.wait_for(getattr(self.gateway, cmd.name)(**cmd.args), timeout)
                if task.status == TaskStatus.CANCELLED:
                    return
                if not result.ok:
                    task.status = TaskStatus.FAILED
                    task.error, task.message = result.error, result.message
                    break
            else:
                task.status = TaskStatus.DONE
        except asyncio.TimeoutError:
            await self.gateway.stop()
            if task.status == TaskStatus.CANCELLED:
                return
            task.status, task.error, task.message = TaskStatus.FAILED, 'TIMEOUT', '命令执行超时，已停止'
        except asyncio.CancelledError:
            return
        except Exception:
            await self.gateway.stop()
            if task.status == TaskStatus.CANCELLED:
                return
            task.status, task.error, task.message = TaskStatus.FAILED, 'UPSTREAM_ERROR', '机器人命令执行异常'
        await self._update(task)
        await self._notify(task)

    async def stop(self, reason: str = 'stop') -> dict:
        async with self._stop_lock:
            task = self._current if self._current and self._current.status in {TaskStatus.QUEUED, TaskStatus.RUNNING} else None
            runner = self._runner
            if task:
                task.status, task.error, task.message = TaskStatus.CANCELLED, 'CANCELLED', '任务已停止'
                task.cancel_reason = reason
            try:
                result = await self.gateway.stop()
                ratio = result.detail.get('completed_ratio')
            except Exception:
                ratio = None
                await self.bus.log('error', '机器人停止回执异常')
            if task:
                task.completed_ratio = ratio
            if task and runner:
                runner.cancel()
                with suppress(asyncio.CancelledError):
                    await runner
            if task:
                await self._update(task)
            response = {'task': task.model_copy(deep=True) if task else None, 'completed_ratio': ratio}
            for callback in self._stop_listeners:
                await callback(reason, response)
        if task:
            await self._notify(task)
        await self.bus.log('info', '已执行停止', reason=reason)
        return response

    async def close(self):
        await self.stop('shutdown')
        if self._runner:
            with suppress(asyncio.CancelledError):
                await self._runner


class StatePublisher:
    def __init__(self, gateway: RobotGateway, scheduler: Scheduler, bus: EventBus, interval_s: float = 1.0):
        self.gateway, self.scheduler, self.bus, self.interval_s = gateway, scheduler, bus, interval_s
        self._runner: asyncio.Task | None = None

    async def get_state(self):
        state = await self.gateway.get_state()
        state.stale = not state.online
        state.busy = (state.busy if state.online else False) or self.scheduler.busy
        if not state.online:
            state.action_status = 'UNKNOWN'
        task = self.scheduler.current()
        state.current_command = task.steps[task.current_step].name if state.busy and task and task.status in {TaskStatus.RUNNING, TaskStatus.QUEUED} else None
        return state

    def start(self):
        self._runner = asyncio.create_task(self._run())

    async def _run(self):
        while True:
            try:
                state = await self.get_state()
                await self.bus.publish('robot.state', state.model_dump(mode='json'))
            except Exception:
                # 日志通道自身故障时也不能终止状态循环。
                with suppress(Exception):
                    await self.bus.log('error', '机器人状态推送失败，将继续重试')
            await asyncio.sleep(self.interval_s)

    async def close(self):
        if self._runner:
            self._runner.cancel()
            with suppress(asyncio.CancelledError):
                await self._runner
