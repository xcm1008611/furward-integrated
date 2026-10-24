from __future__ import annotations

import asyncio
import bisect
import copy
import hashlib
import hmac
import json
import math
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .detours import DetourPlan, NoDetourSpace, distances, initial_navigation, plan_detour

HEARTBEAT_TIMEOUT = object()


class DemoError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


@dataclass(frozen=True)
class Config:
    ttl_s: float = 1800
    max_sessions: int = 100
    tick_s: float = 0.1
    disconnect_pause_s: float = 10
    heartbeat_timeout_s: float = 15
    auth_timeout_s: float = 5
    run_ticker: bool = True


@dataclass(frozen=True)
class World:
    payload: dict
    total: float
    speed: float
    step_ends: tuple[float, ...]
    obstacle_distance: float

    @classmethod
    def load(cls, path: Path) -> World:
        data = json.loads(path.read_text(encoding='utf-8'))
        route = data['route']
        total, speed = float(route['total_distance_m']), float(route['speed_mps'])
        ends = tuple(float(step['end_m']) for step in route['steps'])
        starts = tuple(float(step['start_m']) for step in route['steps'])
        obstacle = float(route['obstacle_distance_m'])
        if (not ends or not all(math.isfinite(v) for v in (total, speed, obstacle, *ends, *starts))
                or total <= 0 or speed <= 0 or not 0 < obstacle < total
                or abs(ends[-1] - total) > 0.01 or abs(starts[0]) > 0.01
                or any(end <= start for start, end in zip(starts, ends))
                or any(abs(start - previous) > 0.01 for start, previous in zip(starts[1:], ends))):
            raise ValueError('shared/route.json contains an invalid route')
        points = route['points']
        if (len(points) < 2 or not all(math.isfinite(p[k]) for p in points for k in ('x', 'y', 'z'))
                or any(math.hypot(b['x'] - a['x'], b['z'] - a['z']) < 1e-6 for a, b in zip(points, points[1:]))
                or abs(distances(points)[-1] - total) > 0.01):
            raise ValueError('shared/route.json points do not match the route length')
        blockers = data.get('detour_blockers')
        if (not isinstance(blockers, list) or any(len(poly) < 3 or any(
                len(p) != 2 or not all(math.isfinite(v) for v in p) for p in poly) for poly in blockers)):
            raise ValueError('shared/route.json requires valid detour_blockers')
        return cls(data, total, speed, ends, obstacle)


@dataclass
class Session:
    session_id: str
    token_hash: bytes
    last_seen: float
    last_tick: float
    disconnected_since: float | None
    revision: int = 0
    status: str = 'IDLE'
    distance_m: float = 0
    current_step: int = 0
    pause_reason: str | None = None
    obstacle_active: bool = False
    obstacle_triggered: bool = False
    navigation: dict = field(default_factory=dict)
    obstacles: list[dict] = field(default_factory=list)
    detour_until_m: float | None = None
    pending_detour: DetourPlan | None = None
    message: str = '准备好了，点击开始出发。'
    # Each socket owns its own lease. A replacement socket cannot keep an old
    # half-open connection alive merely by pinging the same session.
    subscribers: dict[asyncio.Queue, float] = field(default_factory=dict)

    def snapshot(self) -> dict:
        return {name: getattr(self, name) for name in (
            'session_id', 'revision', 'status', 'current_step', 'pause_reason',
            'obstacle_active', 'obstacle_triggered', 'message', 'detour_until_m')} | {
                'distance_m': round(self.distance_m, 4), 'navigation': copy.deepcopy(self.navigation),
                'obstacles': copy.deepcopy(self.obstacles)}

    def publish(self):
        self.revision += 1
        self.deliver(self.snapshot())

    def deliver(self, state: dict | None):
        for queue in tuple(self.subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(state)


class Registry:
    """Methods run without awaits on one ASGI event loop; no shared robot state."""

    def __init__(self, world: World, config: Config, clock: Callable[[], float] = time.monotonic):
        self.world, self.config, self.clock = world, config, clock
        self.sessions: dict[str, Session] = {}
        # Automatic obstacle placement is validated before the service becomes
        # ready. A missing/unsafe city definition must not silently drive
        # through the obstacle. Manual obstacles disable this automatic event.
        self._automatic_detour = plan_detour(world.payload, initial_navigation(world.payload),
                                           world.obstacle_distance, [], 'obstacle-1')

    def create(self) -> dict:
        self.sweep()
        if len(self.sessions) >= self.config.max_sessions:
            raise DemoError('SESSION_LIMIT', '当前体验人数较多，请稍后再试。', 429)
        token, session_id, now = secrets.token_urlsafe(32), secrets.token_urlsafe(18), self.clock()
        session = Session(session_id, hashlib.sha256(token.encode()).digest(), now, now, now)
        session.navigation = initial_navigation(self.world.payload)
        self.sessions[session_id] = session
        return {'session_id': session_id, 'token': token, 'state': session.snapshot()}

    def authenticate(self, session_id: str, token: str, *, touch: bool = True) -> Session:
        self.sweep()
        session = self.sessions.get(session_id)
        if session is None:
            raise DemoError('NOT_FOUND', '体验会话已过期，请重新开始。', 404)
        if not isinstance(token, str) or not hmac.compare_digest(
                session.token_hash, hashlib.sha256(token.encode()).digest()):
            raise DemoError('AUTH', '会话凭据无效，请重新开始。', 401)
        if touch:
            session.last_seen = self.clock()
        self.advance(session)
        return session

    def attach(self, session: Session) -> asyncio.Queue:
        self.advance(session)
        queue: asyncio.Queue = asyncio.Queue(maxsize=2)
        session.subscribers[queue] = self.clock() + self.config.heartbeat_timeout_s
        session.disconnected_since = None
        session.last_seen = self.clock()
        queue.put_nowait(session.snapshot())
        return queue

    def detach(self, session: Session, queue: asyncio.Queue):
        self.expire_connections(session)
        session.subscribers.pop(queue, None)
        if not session.subscribers and session.disconnected_since is None:
            session.disconnected_since = self.clock()

    def heartbeat(self, session: Session, queue: asyncio.Queue):
        self.sweep()
        if session.session_id not in self.sessions:
            raise DemoError('NOT_FOUND', '体验会话已过期，请重新开始。', 404)
        self.expire_connections(session)
        if queue not in session.subscribers:
            raise DemoError('CONNECTION_TIMEOUT', '连接心跳已超时，请重新连接。', 408)
        now = self.clock()
        session.subscribers[queue] = now + self.config.heartbeat_timeout_s
        session.last_seen = now

    def expire_connections(self, session: Session):
        now = self.clock()
        expired = [(queue, deadline) for queue, deadline in session.subscribers.items() if now >= deadline]
        for queue, _ in expired:
            session.subscribers.pop(queue)
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(HEARTBEAT_TIMEOUT)
        if expired and not session.subscribers and session.disconnected_since is None:
            # Use the actual lease deadline, not this tick's time. Event-loop
            # delays must not add extra travel time to a disconnected session.
            session.disconnected_since = max(deadline for _, deadline in expired)

    def advance(self, session: Session):
        self.expire_connections(session)
        now = self.clock()
        if session.status != 'ACTIVE':
            session.last_tick = now
            return
        advance_until = now
        disconnected = session.disconnected_since
        deadline = disconnected + self.config.disconnect_pause_s if disconnected is not None else None
        if deadline is not None:
            advance_until = min(advance_until, deadline)
        total = session.navigation['total_distance_m']
        next_distance = min(total, session.distance_m + max(0, advance_until - session.last_tick) * self.world.speed)
        session.last_tick = now
        if not session.obstacle_triggered and next_distance >= self.world.obstacle_distance:
            next_distance = self.world.obstacle_distance
            self.place_obstacle(session, self._automatic_detour)
        session.distance_m = next_distance
        session.current_step = bisect.bisect_right(session.navigation['step_end_distances'], next_distance)
        if session.detour_until_m is not None and next_distance >= session.detour_until_m:
            session.detour_until_m = None
        if next_distance >= total:
            session.status, session.pause_reason = 'DONE', None
            session.message = f"已到达{self.world.payload['route']['destination_name']}。"
        elif session.status == 'ACTIVE' and deadline is not None and now >= deadline:
            session.status, session.pause_reason = 'PAUSED', 'disconnected'
            session.message = '连接已断开，演示已暂停。重新连接后点击继续。'
        elif session.status == 'ACTIVE':
            session.message = self.instruction(session)
        session.publish()

    def instruction(self, session: Session) -> str:
        if session.detour_until_m is not None:
            return '正在从障碍旁绕行，障碍保留原位，绒途带你继续前进。'
        step = self.world.payload['route']['steps'][session.current_step]
        ends = session.navigation['step_end_distances']
        actual_length = ends[session.current_step] - (ends[session.current_step - 1] if session.current_step else 0)
        if abs(actual_length - step['distance_m']) > 0.01:
            return re.sub(r'(约\s*)?\d+(?:\.\d+)?\s*米', f'约 {round(actual_length)} 米', step['instruction']) + '（含绕行）'
        return step['instruction']

    def place_obstacle(self, session: Session, plan: DetourPlan):
        session.pending_detour = plan
        session.obstacles.append(copy.deepcopy(plan.obstacle))
        session.obstacle_active = session.obstacle_triggered = True
        session.status, session.pause_reason = 'PAUSED', 'obstacle'
        session.message = '前方有障碍物，已停下。点击绕行前进，绒途会带你从旁边通过。'

    def bypass(self, session: Session):
        plan = session.pending_detour
        if not session.obstacle_active or plan is None:
            return
        session.navigation = copy.deepcopy(plan.navigation)
        session.detour_until_m = plan.until_m
        session.pending_detour = None
        session.obstacle_active = False
        session.status, session.pause_reason = 'ACTIVE', None
        session.message = self.instruction(session)

    def action(self, session: Session, action: str) -> dict:
        self.advance(session)
        now = self.clock()
        if action == 'start':
            if session.status == 'ACTIVE':
                return session.snapshot()
            if session.status != 'IDLE':
                raise DemoError('INVALID_STATE', '暂停后请点击继续；结束后请重新体验。', 409)
            session.status, session.pause_reason = 'ACTIVE', None
            session.message = self.instruction(session)
        elif action == 'pause':
            if session.status == 'PAUSED':
                return session.snapshot()
            if session.status != 'ACTIVE':
                raise DemoError('INVALID_STATE', '当前没有正在进行的导航。', 409)
            session.status, session.pause_reason = 'PAUSED', 'user'
            session.message = '已停下，点击继续即可沿剩余路线出发。'
        elif action == 'resume':
            if session.status == 'ACTIVE':
                return session.snapshot()
            if session.status != 'PAUSED':
                raise DemoError('INVALID_STATE', '只有暂停中的导航可以继续。', 409)
            if session.obstacle_active:
                self.bypass(session)
            else:
                session.status, session.pause_reason = 'ACTIVE', None
                session.message = self.instruction(session)
        elif action == 'cancel':
            if session.status in {'CANCELLED', 'DONE'}:
                return session.snapshot()
            session.status, session.pause_reason = 'CANCELLED', None
            session.obstacle_active, session.pending_detour, session.detour_until_m = False, None, None
            session.message = '导航已结束。点击重新体验可返回起点。'
        elif action == 'reset':
            session.status, session.pause_reason = 'IDLE', None
            session.distance_m, session.current_step = 0, 0
            session.obstacle_active = session.obstacle_triggered = False
            session.navigation = initial_navigation(self.world.payload)
            session.obstacles, session.pending_detour, session.detour_until_m = [], None, None
            session.message = '已回到起点，点击开始出发。'
        elif action == 'obstacle':
            if session.status not in {'ACTIVE', 'PAUSED'}:
                raise DemoError('INVALID_STATE', '请先开始导航，再演示遇障。', 409)
            if session.obstacle_active:
                return session.snapshot()
            if session.detour_until_m is not None:
                raise DemoError('DETOUR_IN_PROGRESS', '正在绕行，请等人和机器狗都通过后再添加障碍。', 409)
            try:
                plan = plan_detour(self.world.payload, session.navigation, session.distance_m,
                                   session.obstacles, f'obstacle-{len(session.obstacles) + 1}')
            except NoDetourSpace as exc:
                raise DemoError('NO_DETOUR_SPACE', str(exc), 409) from exc
            self.place_obstacle(session, plan)
        elif action in {'obstacle_bypass', 'obstacle_clear'}:
            # The legacy action is a compatibility alias. Neither removes the
            # physical obstacle nor resumes an unrelated user/disconnect pause.
            if not session.obstacle_active:
                return session.snapshot()
            self.bypass(session)
        else:
            raise DemoError('INVALID_ARGS', '不支持这个演示操作。')
        session.last_tick, session.last_seen = now, now
        if action in {'start', 'resume', 'obstacle_bypass', 'obstacle_clear'} and session.status == 'ACTIVE' and not session.subscribers:
            session.disconnected_since = now
        session.publish()
        return session.snapshot()

    def sweep(self):
        now = self.clock()
        expired = [key for key, session in self.sessions.items() if now - session.last_seen >= self.config.ttl_s]
        for key in expired:
            self.sessions.pop(key).deliver(None)

    def tick(self):
        self.sweep()
        for session in tuple(self.sessions.values()):
            self.advance(session)

    def close(self):
        for session in self.sessions.values():
            session.deliver(None)
        self.sessions.clear()

