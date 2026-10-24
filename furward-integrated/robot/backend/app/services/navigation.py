import asyncio
import json
import math
from contextlib import suppress
from time import time

from pydantic import ValidationError

from app.errors import ApiError, INVALID_ARGS, MODE_FORBIDDEN, NOT_FOUND, ROBOT_BUSY, UPSTREAM_ERROR
from app.models import Command, DemoMode, NavPlanRequest, Route, TaskStatus
from app.services.amap import location
from app.services.commands import estimate_duration, with_auto_stand
from app.services.coords import haversine_m, wgs84_to_gcj02
from app.services.indoor import data_path, normalize_angle


class NavigationService:
    def __init__(self, settings, scheduler, modes, bus, indoor_map, amap):
        self.settings, self.scheduler, self.modes, self.bus = settings, scheduler, modes, bus
        self.indoor_map, self.amap = indoor_map, amap
        self.route = None
        self.obstacle_monitor = None
        self.status = 'IDLE'
        self.current_step = 0
        self.pause_reason = None
        self.waypoint = indoor_map.start_waypoint
        self.pose = (*indoor_map.point(self.waypoint), indoor_map.start_heading_deg)
        self.last_location = None
        self._pending = []
        self._runner = None
        self._active_task = None
        self._command_pose = self.pose
        self._finished = asyncio.Event()
        self._control_lock = asyncio.Lock()
        self._revision = 0
        self._arrival_text = None
        scheduler.add_listener(self._task_finished)
        scheduler.add_stop_listener(self._stopped)
        modes.is_busy = lambda: scheduler.busy
        modes.navigation = self

    def current(self):
        return {'route': self.route, 'status': self.status, 'current_step': self.current_step, 'pose': self.pose, 'pause_reason': self.pause_reason, 'remaining_m': self.remaining_m()}

    def _check_mode(self, mode=None):
        expected = mode or (self.route.mode if self.route else None)
        if expected != self.modes.mode:
            raise ApiError(MODE_FORBIDDEN, '导航模式与当前演示模式不一致', 403)

    def _require_route(self):
        if not self.route:
            raise ApiError(NOT_FOUND, '请先规划路线', 404)
        self._check_mode()

    def remaining_m(self):
        if not self.route or self.status in {'DONE', 'CANCELLED'}:
            return 0.0
        if self.route.mode == DemoMode.OUTDOOR:
            return sum(step.distance_m for step in self.route.steps[self.current_step:])
        remaining = sum(cmd.args['distance_m'] for cmd, _ in self._pending if cmd.name == 'move')
        if self._active_task and self._pending and self._pending[0][0].name == 'move':
            task = self.scheduler.current()
            ratio = 0.0
            if task and task.id == self._active_task and task.step_started_at:
                duration = estimate_duration(self._pending[0][0], self.settings)
                ratio = min(1, max(0, (time() - task.step_started_at) / duration))
            remaining -= self._pending[0][0].args['distance_m'] * ratio
        return max(0.0, remaining)

    async def clear_route(self):
        self._revision += 1
        self.route = None
        self.status, self.current_step, self.pause_reason = 'IDLE', 0, None
        self._pending.clear()
        self._arrival_text = None
        await self.bus.publish('nav.route', None)
        await self._progress()

    async def _progress(self):
        data = self.current()
        data.pop('route')
        await self.bus.publish('nav.progress', data)

    @staticmethod
    def _coordinate(point):
        lng, lat = point
        if not math.isfinite(lng) or not math.isfinite(lat) or not -180 <= lng <= 180 or not -90 <= lat <= 90:
            raise ApiError(INVALID_ARGS, '经纬度超出允许范围')
        return lng, lat

    async def plan(self, req: NavPlanRequest) -> Route:
        async with self._control_lock:
            revision = self._revision
            self._check_mode(req.mode)
            if self.status == 'ACTIVE' or self.scheduler.busy:
                raise ApiError(ROBOT_BUSY, '执行中不能重新规划路线', 409)
            if req.mode == DemoMode.INDOOR:
                if not req.to:
                    raise ApiError(INVALID_ARGS, '请指定室内目的地')
                start = self.indoor_map.find(req.from_id or self.waypoint)
                route = self.indoor_map.plan(start, req.to, self.pose[2])
                pose = (*self.indoor_map.point(start), self.pose[2])
            else:
                if not req.destination:
                    raise ApiError(INVALID_ARGS, '请指定室外目的地')
                name = req.destination if isinstance(req.destination, str) else ','.join(map(str, req.destination))
                # 点名要演示路线时直接用缓存：它有固定起点，也不能被高德上的同名真实地点抢走
                demo = await asyncio.to_thread(self._cached, name) if isinstance(req.destination, str) else None
                if demo is not None and demo.sample:
                    route = demo
                else:
                    route = await self._plan_outdoor(req, name)
            if revision != self._revision:
                raise ApiError('CANCELLED', '规划期间已停止或取消，请重新规划')
            self._check_mode(req.mode)
            if self.status == 'ACTIVE' or self.scheduler.busy:
                raise ApiError(ROBOT_BUSY, '执行中不能替换路线', 409)
            if req.mode == DemoMode.INDOOR:
                self.pose, self.waypoint = pose, start
            self._arrival_text = None
            self.route, self.status, self.current_step, self.pause_reason = route, 'IDLE', 0, None
            self.route.current_step = 0
            self._pending = [(cmd.model_copy(deep=True), step.index) for step in route.steps for cmd in step.robot_cmds]
            await self.bus.publish('nav.route', route.model_dump(mode='json'))
            await self._progress()
            return route

    async def _plan_outdoor(self, req: NavPlanRequest, name: str) -> Route:
        origin = req.origin
        if origin is None:
            origin = location(self.settings.outdoor_default_origin)
            if origin is None:
                raise ApiError(INVALID_ARGS, '请提供起点或配置室外默认起点')
        else:
            origin = self._coordinate(origin)
            if req.origin_coord == 'wgs84':
                origin = wgs84_to_gcj02(*origin)
        try:
            if isinstance(req.destination, str):
                lng, lat, resolved_name = await self.amap.search_place(req.destination)
                destination = (lng, lat)
            else:
                destination, resolved_name = self._coordinate(req.destination), name
            route = Route.model_validate(await self.amap.walking(origin, destination))
            route.destination_name = resolved_name
            route.aliases = [name] if name != resolved_name else []
            return route
        except ApiError as exc:
            if exc.code == NOT_FOUND:
                names = await asyncio.to_thread(self._cached_names)
                suggestion = '可以去：' + '、'.join(names) if names else '请换一个地名或提供目的地坐标'
                raise ApiError(NOT_FOUND, f'没有找到"{name}"，{suggestion}', 404) from exc
            if exc.code != UPSTREAM_ERROR:
                raise
            route = await asyncio.to_thread(self._cached, name)
            if route is None:
                raise
            return route

    def _cached_names(self):
        names = []
        for path in sorted(data_path(self.settings.demo_routes_dir).glob('*.json')):
            try:
                route = Route.model_validate(json.loads(path.read_text(encoding='utf-8')))
                if route.mode == DemoMode.OUTDOOR and route.destination_name:
                    names.append(route.destination_name)
            except (OSError, ValueError, ValidationError):
                continue
        return names

    def _cached(self, name):
        for path in sorted(data_path(self.settings.demo_routes_dir).glob('*.json')):
            try:
                route = Route.model_validate(json.loads(path.read_text(encoding='utf-8')))
            except (OSError, ValueError, ValidationError):
                continue
            if route.mode == DemoMode.OUTDOOR and route.coord == 'gcj02' and name in [route.destination_name, *route.aliases]:
                route.cached = True
                return route
        return None

    async def _speak(self, text):
        if self.route and self.route.mode == DemoMode.INDOOR and self.status == 'ACTIVE':
            return
        if not self.scheduler.busy:
            try:
                await self.scheduler.submit('导航播报', [Command(name='speak', args={'text': text[:100]})], 'nav')
            except ApiError as exc:
                if exc.code != ROBOT_BUSY:
                    raise

    async def next(self):
        self._require_route()
        if self.route.mode == DemoMode.INDOOR and self.status in {'ACTIVE', 'PAUSED'}:
            raise ApiError(ROBOT_BUSY, '行走过程中不能手动跳过步骤', 409)
        if self.status in {'PAUSED', 'CANCELLED', 'FAILED'}:
            raise ApiError(INVALID_ARGS, '请重新规划路线')
        if self.status == 'DONE':
            return self.current()
        self.current_step += 1
        self.route.current_step = self.current_step
        if self.current_step >= len(self.route.steps):
            await self._done()
        else:
            if self.route.mode == DemoMode.OUTDOOR:
                self.status = 'ACTIVE'
            await self._speak(self.route.steps[self.current_step].instruction)
            await self._progress()
        return self.current()

    async def repeat(self):
        self._require_route()
        if self.current_step < len(self.route.steps):
            await self._speak(self.route.steps[self.current_step].instruction)
        await self._progress()
        return self.current()

    async def execute(self):
        async with self._control_lock:
            if self.modes.mode != DemoMode.INDOOR:
                raise ApiError(MODE_FORBIDDEN, '室外模式禁止执行导航运动', 403)
            self._require_route()
            if self.status != 'IDLE':
                raise ApiError(INVALID_ARGS, '导航尚未就绪，请继续或重新规划')
            await self._start()
            if self.obstacle_monitor:
                await self.obstacle_monitor.navigation_started()
            else:
                await self.bus.log('info', '障碍物识别未启用')
            return self.current()

    async def _start(self):
        self._check_mode(DemoMode.INDOOR)
        if self.scheduler.busy:
            raise ApiError(ROBOT_BUSY, '已有任务正在执行', 409)
        revision = self._revision
        state = await self.scheduler.require_online()
        if revision != self._revision:
            raise ApiError('CANCELLED', '启动期间已停止或取消，请重新操作')
        self._check_mode(DemoMode.INDOOR)
        if self._pending:
            first, index = self._pending[0]
            self._pending[:1] = [(cmd, index) for cmd in with_auto_stand([first], state.action)]
        self.scheduler.reserved_source = 'nav'
        self.status, self.pause_reason = 'ACTIVE', None
        self._runner = asyncio.create_task(self._run())
        await self._progress()

    async def _task_finished(self, task):
        if task.id == self._active_task:
            self._finished.set()
        if self._arrival_text and self.status == 'DONE' and not self.scheduler.busy:
            text, self._arrival_text = self._arrival_text, None
            await self._speak(text)

    def _apply(self, cmd, ratio):
        x, y, heading = self._command_pose
        if cmd.name == 'move':
            distance = cmd.args['distance_m'] * ratio
            x += distance * math.cos(math.radians(heading))
            y += distance * math.sin(math.radians(heading))
        elif cmd.name == 'turn':
            heading = normalize_angle(heading + cmd.args['angle_deg'] * ratio)
        self.pose = x, y, heading

    def _record_waypoint(self):
        for key in self.indoor_map.waypoints:
            if math.dist(self.pose[:2], self.indoor_map.point(key)) <= self.settings.nav_resume_min_move_m:
                self.waypoint = key

    async def _run(self):
        try:
            while self._pending and self.status == 'ACTIVE':
                cmd, index = self._pending[0]
                self.current_step = self.route.current_step = index
                self._command_pose = self.pose
                self._finished.clear()
                task = await self.scheduler.submit('室内导航', [cmd], 'nav')
                self._active_task = task.id
                while not self._finished.is_set():
                    try:
                        await asyncio.wait_for(self._finished.wait(), self.settings.nav_progress_interval_s)
                    except asyncio.TimeoutError:
                        task = self.scheduler.current()
                        if task and task.id == self._active_task and task.step_started_at and cmd.name == 'move':
                            duration = estimate_duration(cmd, self.settings)
                            self._apply(cmd, min(1, max(0, (time()-task.step_started_at) / duration)))
                            await self._progress()
                task = self.scheduler.current()
                if task.status != TaskStatus.DONE:
                    raise ApiError(task.error or UPSTREAM_ERROR, task.message or '导航命令失败')
                self._apply(cmd, 1)
                self._pending.pop(0)
                self._active_task = None
                self._record_waypoint()
                await self._progress()
                scale = self.settings.mock_time_scale if self.settings.robot_backend == 'mock' else 1
                await asyncio.sleep(self.settings.nav_settle_s * scale)
            if self.status == 'ACTIVE':
                await self._done()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._active_task = None
            self.scheduler.reserved_source = None
            self.status = 'FAILED'
            await self.bus.log('error', '导航执行失败', error=getattr(exc, 'code', UPSTREAM_ERROR), message=getattr(exc, 'message', '导航命令执行异常'))
            await self._progress()

    async def _stopped(self, reason, response):
        self._revision += 1
        self._arrival_text = None
        if self.status != 'ACTIVE':
            return
        self.scheduler.reserved_source = None
        self.status = 'PAUSED'
        self.pause_reason = reason if reason in {'user', 'obstacle'} else 'stop'
        if self._runner and self._runner is not asyncio.current_task():
            self._runner.cancel()
            with suppress(asyncio.CancelledError):
                await self._runner
        if self._active_task and self._pending:
            cmd, index = self._pending[0]
            task = response['task'] or self.scheduler.current()
            ratio = 0.0
            if task and task.id == self._active_task:
                ratio = 1.0 if task.status == TaskStatus.DONE else response['completed_ratio'] or 0.0
            ratio = min(1, max(0, ratio))
            self._apply(cmd, ratio)
            if ratio >= 1:
                self._pending.pop(0)
            elif cmd.name in {'move', 'turn'}:
                key = 'distance_m' if cmd.name == 'move' else 'angle_deg'
                self._pending[0] = (Command(name=cmd.name, args={key: cmd.args[key]*(1-ratio)}), index)
            self._record_waypoint()
        self._active_task = None
        await self._progress()

    async def pause(self, reason='user'):
        if reason not in {'user', 'obstacle'}:
            raise ApiError(INVALID_ARGS, '暂停原因必须是 user 或 obstacle')
        if self.status != 'ACTIVE':
            raise ApiError(INVALID_ARGS, '仅执行中的导航可以暂停')
        await self.scheduler.stop(reason)
        return self.current()

    async def resume(self):
        async with self._control_lock:
            self._require_route()
            if self.status != 'PAUSED':
                raise ApiError(INVALID_ARGS, '仅暂停中的导航可以继续')
            if self.route.mode == DemoMode.OUTDOOR:
                self.status, self.pause_reason = 'ACTIVE', None
                await self._progress()
            else:
                while self._pending:
                    cmd = self._pending[0][0]
                    small = (cmd.name == 'move' and cmd.args['distance_m'] < self.settings.nav_resume_min_move_m) or (cmd.name == 'turn' and abs(cmd.args['angle_deg']) < self.settings.nav_resume_min_turn_deg)
                    if not small:
                        break
                    self._pending.pop(0)
                await self._start()
            return self.current()

    async def cancel(self):
        await self.scheduler.stop('nav_cancel')
        self._pending.clear()
        self.status, self.pause_reason = 'CANCELLED', None
        await self._progress()
        return self.current()

    async def _done(self):
        self.scheduler.reserved_source = None
        self.status, self.pause_reason = 'DONE', None
        if self.route.mode == DemoMode.INDOOR and self.route.polyline:
            self.pose = (*self.route.polyline[-1], self.pose[2])
            self._record_waypoint()
        self._pending.clear()
        self.current_step = self.route.current_step = len(self.route.steps)
        text = f'已到达{self.route.destination_name}'
        if self.scheduler.busy:
            self._arrival_text = text
        else:
            await self._speak(text)
        await self._progress()

    async def update_location(self, lng, lat, coord='gcj02'):
        self._require_route()
        if self.route.mode != DemoMode.OUTDOOR:
            raise ApiError(MODE_FORBIDDEN, '仅室外导航接受经纬度定位', 403)
        point = self._coordinate((lng, lat))
        if coord not in {'wgs84', 'gcj02'}:
            raise ApiError(INVALID_ARGS, '定位坐标系不合法')
        self.last_location = wgs84_to_gcj02(*point) if coord == 'wgs84' else point
        if self.status in {'IDLE', 'ACTIVE'} and self.current_step < len(self.route.steps):
            if haversine_m(self.last_location, self.route.steps[self.current_step].end) < self.settings.nav_arrive_radius_m:
                await self.next()
        return self.current()

    async def close(self):
        await self.cancel()
