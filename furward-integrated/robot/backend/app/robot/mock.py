import asyncio
import inspect
import time

from app.config import Settings
from app.models import CmdResult, Command, RobotEvent, RobotState
from app.robot.gateway import EventHandler
from app.services.commands import estimate_duration

LOCOMOTION = 'QUADRUPED_LOCOMOTION_DEFAULT'


class MockRobot:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._state = RobotState(battery=settings.mock_battery_start)
        self._handlers: list[EventHandler] = []
        self._active: str | None = None
        self._cancel: asyncio.Event | None = None
        self._started = 0.0
        self._duration = 0.0
        self._stop_detail: dict | None = None
        self._fail = {name.strip() for name in settings.mock_fail.split(',') if name.strip()}

    def on_event(self, handler: EventHandler) -> None:
        self._handlers.append(handler)

    async def _emit(self):
        for handler in self._handlers:
            result = handler(RobotEvent(type='robot.state', data=self._state.model_dump()))
            if inspect.isawaitable(result):
                await result

    async def connect(self) -> None:
        self._state.online = True
        await self._emit()

    async def get_state(self) -> RobotState:
        return self._state.model_copy(deep=True)

    def _progress(self) -> dict:
        elapsed = max(0.0, time.monotonic() - self._started)
        return {'elapsed_s': elapsed, 'completed_ratio': min(1.0, elapsed / self._duration) if self._duration else 1.0}

    async def _execute(self, name: str, args: dict) -> CmdResult:
        if name in self._fail:
            await self._emit()
            return CmdResult(ok=False, error='MOCK_FAIL', message='模拟命令失败')
        if self._active is not None:
            await self._emit()
            return CmdResult(ok=False, error='ROBOT_BUSY', message='机器狗正在执行命令')
        if name in {'move', 'turn', 'mimic'} and self._state.action != LOCOMOTION:
            await self._emit()
            return CmdResult(ok=False, error='NOT_READY', message='请先让机器狗站起并进入行走状态')
        self._active = name
        self._state.busy = True
        self._state.current_command = name
        self._duration = estimate_duration(Command(name=name, args=args), self.settings)
        self._started = time.monotonic()
        self._cancel = asyncio.Event()
        self._stop_detail = None
        original_action = self._state.action
        try:
            await self._emit()
            if name == 'stand_up':
                for action in ('QUADRUPED_STAND_DEFAULT', LOCOMOTION):
                    self._state.action = action
                    self._state.action_status = 'TRANSITION'
                    await self._emit()
                    await asyncio.sleep(self._duration / 2)
            elif name == 'posture':
                self._state.action_status = 'TRANSITION'
                await self._emit()
                await asyncio.sleep(self._duration)
                self._state.action = {'stand': LOCOMOTION, 'sit': 'QUADRUPED_SIT_DOWN_DEFAULT', 'lie_down': 'QUADRUPED_GET_DOWN_DEFAULT'}[args['name']]
            elif name in {'move', 'turn'}:
                try:
                    await asyncio.wait_for(self._cancel.wait(), timeout=self._duration)
                except asyncio.TimeoutError:
                    pass
                if self._cancel.is_set():
                    return CmdResult(ok=False, error='CANCELLED', message='运动已停止', detail=self._stop_detail or self._progress())
            else:
                await asyncio.sleep(self._duration)
            return CmdResult(ok=True, detail={'duration_s': time.monotonic() - self._started})
        except asyncio.CancelledError:
            # 中断切换时恢复最后稳定姿态，避免留下永久过渡状态。
            if name in {'stand_up', 'posture'}:
                self._state.action = original_action
            raise
        finally:
            if name in {'move', 'turn'}:
                self._state.battery = max(0, (self._state.battery or 0) - 1)
            self._active = None
            self._cancel = None
            self._state.action_status = 'RUNNING'
            self._state.busy = False
            self._state.current_command = None
            await self._emit()

    async def stand_up(self) -> CmdResult:
        return await self._execute('stand_up', {})

    async def posture(self, name: str) -> CmdResult:
        return await self._execute('posture', {'name': name})

    async def mimic(self, motion: str) -> CmdResult:
        return await self._execute('mimic', {'motion': motion})

    async def move(self, distance_m: float) -> CmdResult:
        return await self._execute('move', {'distance_m': distance_m})

    async def turn(self, angle_deg: float) -> CmdResult:
        return await self._execute('turn', {'angle_deg': angle_deg})

    async def speak(self, text: str, interrupt: bool = False) -> CmdResult:
        # 播报独立于运动，不能占用或覆盖运动进度。
        if 'speak' in self._fail:
            return CmdResult(ok=False, error='MOCK_FAIL', message='模拟命令失败')
        duration = estimate_duration(Command(name='speak', args={'text': text}), self.settings)
        await asyncio.sleep(duration)
        return CmdResult(ok=True, detail={'duration_s': duration})

    async def led(self, mode: str) -> CmdResult:
        return await self._execute('led', {'mode': mode})

    async def stop(self) -> CmdResult:
        detail = {}
        if self._active in {'move', 'turn'} and self._cancel is not None:
            self._stop_detail = self._stop_detail or self._progress()
            detail = dict(self._stop_detail)
            self._cancel.set()
        await self._emit()
        # 即使注入 stop 故障，也先停止运动。
        if 'stop' in self._fail:
            return CmdResult(ok=False, error='MOCK_FAIL', message='模拟停止回执失败，运动已停止', detail=detail)
        return CmdResult(ok=True, detail=detail)

    async def snapshot(self) -> bytes | None:
        def render():
            import cv2
            import numpy as np
            frame = np.full((480, 640, 3), 230, dtype=np.uint8)
            cv2.rectangle(frame, (80, 180), (240, 400), (80, 140, 220), -1)
            cv2.rectangle(frame, (380, 230), (560, 380), (160, 200, 80), -1)
            cv2.putText(frame, 'MOCK CAMERA', (70, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (30, 30, 30), 3)
            ok, encoded = cv2.imencode('.jpg', frame)
            return encoded.tobytes() if ok else None
        return await asyncio.to_thread(render)
