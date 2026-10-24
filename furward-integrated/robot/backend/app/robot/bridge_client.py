import asyncio
import base64
import binascii
import inspect
import math
import time
from contextlib import suppress

from app.models import CmdResult, RobotEvent, RobotState


def offline():
    return CmdResult(ok=False, error='ROBOT_OFFLINE', message='机器狗未连接')


class BridgeRobot:
    def __init__(self, settings):
        self.settings = settings
        self._ws = None
        self._last_seen = 0.0
        self._state = RobotState(backend='bridge')
        self._pending = {}
        self._counter = 0
        self._handlers = []
        self._heartbeat = None
        self._attach_lock = asyncio.Lock()
        self.adapter = None
        self._reported_online = False

    def on_event(self, handler):
        self._handlers.append(handler)

    async def emit(self, kind, data):
        for handler in self._handlers:
            result = handler(RobotEvent(type=kind, data=data))
            if inspect.isawaitable(result):
                await result

    async def connect(self):
        if self._heartbeat is None:
            self._heartbeat = asyncio.create_task(self._ping_loop())

    @property
    def online(self):
        return self._ws is not None and time.monotonic() - self._last_seen <= self.settings.bridge_stale_s

    async def _connection(self):
        online = self.online
        if online != self._reported_online:
            self._reported_online = online
            await self.emit('robot.connection', {'online': online, 'adapter': self.adapter})

    def _fail_pending(self):
        for future in self._pending.values():
            if not future.done():
                future.set_result(offline())
        self._pending.clear()

    async def attach(self, ws, adapter=None):
        async with self._attach_lock:
            old = self._ws
            self._fail_pending()
            self._ws = ws
            self.adapter = adapter
            # hello 为首个存活凭据，此后仅 state/pong 刷新。
            self._last_seen = time.monotonic()
            self._state = RobotState(backend='bridge')
            if old is not None and old is not ws:
                with suppress(Exception):
                    await old.close(code=1012)
            self._reported_online = True
            await self.emit('robot.connection', {'online': True, 'adapter': adapter})

    async def detach(self, ws):
        if ws is not self._ws:
            return False
        self._ws = None
        self._fail_pending()
        await self._connection()
        await self.emit('log', {'stage': 'error', 'text': '桥接断开'})
        return True

    async def get_state(self):
        return self._state.model_copy(update={'online': self.online, 'backend': 'bridge'}, deep=True)

    async def receive(self, ws, message):
        if ws is not self._ws or not isinstance(message, dict):
            return
        kind = message.get('type')
        if kind == 'result':
            future = self._pending.get(message.get('id'))
            if future is not None and not future.done():
                future.set_result(CmdResult.model_validate(message))
        elif kind in {'state', 'pong'}:
            if kind == 'state':
                self._state = RobotState.model_validate({**message, 'backend': 'bridge'})
            self._last_seen = time.monotonic()
            await self._connection()
            if kind == 'state':
                await self.emit('robot.state', (await self.get_state()).model_dump())
        elif kind in {'asr', 'log', 'error'}:
            await self.emit(kind, {k: v for k, v in message.items() if k != 'type'})

    async def _send(self, ws, message):
        if ws is None or ws is not self._ws:
            return False
        try:
            await ws.send_json(message)
            return True
        except Exception:
            await self.detach(ws)
            return False

    async def _ping_loop(self):
        while True:
            if self._ws is not None:
                if not self.online:
                    self._fail_pending()
                await self._connection()
                await self._send(self._ws, {'type': 'ping', 'ts': time.time()})
            await asyncio.sleep(self.settings.bridge_ping_interval_s)

    def _packet(self, name, args):
        self._counter += 1
        return {'type': 'cmd', 'id': f'c-{self._counter}', 'name': name,
                'args': args, 'deadline_ms': round(self.settings.cmd_deadline_s * 1000)}

    async def _command(self, name, args):
        if not self.online:
            if name == 'stop':
                await self.emit('log', {'stage': 'error', 'text': '机器狗离线，无法下发停止，请用遥控器'})
            return offline()
        ws = self._ws
        packet = self._packet(name, args)
        future = asyncio.get_running_loop().create_future()
        self._pending[packet['id']] = future
        try:
            if not await self._send(ws, packet):
                return offline()
            try:
                return await asyncio.wait_for(future, packet['deadline_ms'] / 1000 + 2)
            except asyncio.TimeoutError:
                # 补发不等待回执，避免 stop 超时递归。
                await self._send(ws, self._packet('stop', {}))
                return CmdResult(ok=False, error='TIMEOUT', message='桥接命令超时，已补发停止')
        finally:
            self._pending.pop(packet['id'], None)

    async def stand_up(self):
        return await self._command('stand_up', {})

    async def posture(self, name):
        return await self._command('posture', {'name': name})

    async def mimic(self, motion):
        return await self._command('mimic', {'motion': motion})

    async def move(self, distance_m):
        s = self.settings
        return await self._command('move', {'distance_m': distance_m, 'speed_mps': s.linear_speed,
            'duration_s': distance_m / (s.linear_speed * s.calib_linear_scale)})

    async def turn(self, angle_deg):
        s = self.settings
        return await self._command('turn', {'angle_deg': angle_deg,
            'angular_speed': math.copysign(s.angular_speed, angle_deg),
            'duration_s': abs(math.radians(angle_deg)) / (s.angular_speed * s.calib_angular_scale)})

    async def stop(self):
        return await self._command('stop', {})

    async def speak(self, text, interrupt=False):
        return await self._command('speak', {'text': text, 'interrupt': interrupt})

    async def led(self, mode):
        return await self._command('led', {'mode': mode})

    async def snapshot(self):
        result = await self._command('snapshot', {})
        if result.ok:
            try:
                return base64.b64decode(result.detail['jpeg_b64'], validate=True) or None
            except (KeyError, ValueError, TypeError, binascii.Error):
                pass
        return None

    async def close(self):
        if self._heartbeat:
            self._heartbeat.cancel()
            await asyncio.gather(self._heartbeat, return_exceptions=True)
            self._heartbeat = None
        ws = self._ws
        if ws is not None:
            await self.detach(ws)
            with suppress(Exception):
                await ws.close(code=1001)
