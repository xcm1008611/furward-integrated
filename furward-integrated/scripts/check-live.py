#!/usr/bin/env python3
"""Exercise the running unified entrypoint with fresh, independent demo sessions.

Run with demo-service/.venv/bin/python scripts/check-live.py [baseURL] [--full-route].
No browser state is read. Tokens are held in memory and never printed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
from urllib.parse import urlsplit, urlunsplit

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus


def report(message):
    print(time.strftime('%H:%M:%S'), message, flush=True)


class Check:
    def __init__(self, base_url, client):
        self.base_url, self.client = base_url.rstrip('/'), client
        parts = urlsplit(self.base_url)
        self.origin = urlunsplit((parts.scheme, parts.netloc, '', '', ''))
        self.ws_url = urlunsplit(('wss' if parts.scheme == 'https' else 'ws', parts.netloc,
                                 parts.path.rstrip('/') + '/ws/demo', '', ''))
        self.created = []

    def headers(self, data, **extra):
        return {'Authorization': 'Bearer ' + data['token'], 'Origin': self.origin, **extra}

    def path(self, data, suffix=''):
        return self.base_url + '/api/demo/sessions/' + data['session_id'] + suffix

    async def create(self):
        response = await self.client.post(self.base_url + '/api/demo/sessions', headers={'Origin': self.origin})
        response.raise_for_status()
        body = response.json()
        assert body['ok'] is True
        data = body['data']
        assert data['state']['status'] == 'IDLE'
        assert data['session_id'] == data['state']['session_id']
        self.created.append(data)
        return data

    async def state(self, data):
        response = await self.client.get(self.path(data), headers=self.headers(data))
        response.raise_for_status()
        return response.json()['data']

    async def action(self, data, action):
        response = await self.client.post(self.path(data, '/actions'), headers=self.headers(data), json={'action': action})
        assert response.status_code == 200, f'{action}: HTTP {response.status_code}, {response.text}'
        return response.json()['data']

    async def text(self, data, text):
        response = await self.client.post(self.path(data, '/text'), headers=self.headers(data), json={'text': text})
        assert response.status_code == 200, f'text: HTTP {response.status_code}, {response.text}'
        return response.json()['data']

    async def reject_socket(self, data, *, wrong_token=False, wrong_origin=False):
        try:
            async with connect(self.ws_url, origin='https://untrusted.example' if wrong_origin else self.origin,
                               open_timeout=8, proxy=None) as ws:
                try:
                    await ws.send(json.dumps({'session_id': data['session_id'],
                                              'token': 'invalid-token' if wrong_token else data['token']}))
                    await asyncio.wait_for(ws.recv(), timeout=8)
                except ConnectionClosed as exc:
                    assert exc.rcvd is not None and exc.rcvd.code == 1008
                else:
                    raise AssertionError('An unauthenticated/cross-site socket received data')
        except InvalidStatus as exc:
            assert wrong_origin and exc.response.status_code in {401, 403}

    async def cleanup(self):
        for data in self.created:
            try:
                await self.action(data, 'cancel')
            except Exception:
                pass


class LiveSession:
    def __init__(self, check, data):
        self.check, self.data = check, data
        self.latest = data['state']
        self.changed = asyncio.Event()
        self.pongs = 0
        self.failure = None
        self.tasks = []

    async def __aenter__(self):
        self.ws = await connect(self.check.ws_url, origin=self.check.origin, open_timeout=8, proxy=None)
        await self.ws.send(json.dumps({'session_id': self.data['session_id'], 'token': self.data['token']}))
        first = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=8))
        assert first['type'] == 'demo.state'
        assert first['data']['session_id'] == self.data['session_id']
        self.latest = first['data']
        self.tasks = [asyncio.create_task(self._receive()), asyncio.create_task(self._heartbeat())]
        return self

    async def _receive(self):
        try:
            async for message in self.ws:
                packet = json.loads(message)
                if packet['type'] == 'demo.state':
                    state = packet['data']
                    assert state['session_id'] == self.data['session_id'], 'Visitor state leaked across sessions'
                    assert state['revision'] >= self.latest['revision'], 'State revision moved backward'
                    self.latest = state
                elif packet['type'] == 'pong':
                    self.pongs += 1
                self.changed.set()
            self.failure = RuntimeError('Live WebSocket closed unexpectedly')
            self.changed.set()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.failure = exc
            self.changed.set()

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(5)
            await self.ws.send(json.dumps({'type': 'ping'}))

    async def wait(self, predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while not predicate():
            if self.failure:
                raise self.failure
            left = deadline - time.monotonic()
            if left <= 0:
                raise AssertionError(f'Timed out waiting for state; latest={self.latest}')
            self.changed.clear()
            await asyncio.wait_for(self.changed.wait(), timeout=left)
        return self.latest

    async def ping(self):
        before = self.pongs
        await self.ws.send(json.dumps({'type': 'ping'}))
        await self.wait(lambda: self.pongs > before)

    async def __aexit__(self, *_):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.ws.close()


async def basic(check):
    a, b = await asyncio.gather(check.create(), check.create())
    assert a['session_id'] != b['session_id'] and a['token'] != b['token']
    no_token = await check.client.get(check.path(a))
    cross_token = await check.client.get(check.path(a), headers=check.headers(b))
    bad_origin = await check.client.get(check.path(a), headers=check.headers(a, Origin='https://untrusted.example'))
    assert no_token.status_code == 401
    assert cross_token.status_code == 401 and 'data' not in cross_token.json()
    assert bad_origin.status_code == 403
    await check.reject_socket(a, wrong_token=True)
    await check.reject_socket(a, wrong_origin=True)
    report('PASS 创建两个独立会话；HTTP / WS 鉴权、恶意 Origin 拒绝')

    async with LiveSession(check, a) as wa, LiveSession(check, b) as wb:
        await asyncio.gather(wa.ping(), wb.ping())
        await asyncio.gather(check.action(a, 'start'), check.action(b, 'start'))
        await asyncio.gather(wa.wait(lambda: wa.latest['distance_m'] >= 1.2), wb.wait(lambda: wb.latest['distance_m'] >= 1.2))
        paused = await check.action(a, 'pause')
        before_b = (await check.state(b))['distance_m']
        await wb.wait(lambda: wb.latest['distance_m'] >= before_b + 1.2)
        after_a, after_b = await asyncio.gather(check.state(a), check.state(b))
        assert after_a['status'] == 'PAUSED' and after_a['distance_m'] == paused['distance_m']
        assert after_b['status'] == 'ACTIVE' and after_b['distance_m'] >= before_b + 1.2
        unknown = await check.text(b, '带我去月球')
        assert unknown['state']['status'] == 'ACTIVE'
        assert unknown['state']['distance_m'] >= after_b['distance_m']
        assert '街心花园' in unknown['reply']
        cancelled_a, cancelled_b = await asyncio.gather(check.text(a, '结束导航'), check.text(b, '不走了'))
        assert cancelled_a['state']['status'] == cancelled_b['state']['status'] == 'CANCELLED'
        assert cancelled_a['state']['distance_m'] == paused['distance_m']
        assert await check.state(a) == cancelled_a['state']
        assert await check.state(b) == cancelled_b['state']
        await wa.wait(lambda: wa.latest['status'] == 'CANCELLED')
        await wb.wait(lambda: wb.latest['status'] == 'CANCELLED')
    async with LiveSession(check, a) as reconnect:
        assert reconnect.latest['status'] == 'CANCELLED'
        assert reconnect.latest['distance_m'] == paused['distance_m']
    report('PASS WS 首包 / 心跳 / 重连；A 暂停时 B 独立前进；文字结束、未知目的地、刷新快照')


async def full_route(check):
    response = await check.client.get(check.base_url + '/api/demo/world')
    response.raise_for_status()
    route = response.json()['data']['route']
    assert route['total_distance_m'] == 150 and route['speed_mps'] == 1.2 and route['obstacle_distance_m'] == 32
    data = await check.create()
    started = time.monotonic()
    obstacle_seen = False
    fixed_obstacles = None
    detour_navigation = None
    next_report = 0
    async with LiveSession(check, data) as live:
        await live.ping()
        await check.action(data, 'start')
        await live.wait(lambda: live.latest['status'] == 'ACTIVE')
        while True:
            if live.failure:
                raise live.failure
            elapsed = time.monotonic() - started
            assert elapsed < 180, 'Full route exceeded the 180-second allowance'
            state = live.latest
            if elapsed >= next_report:
                report(f"路线验收 {elapsed:5.1f}s  {state['status']:9s}  {state['distance_m']:6.2f} / {state['navigation']['total_distance_m']:.4f}m  第 {min(state['current_step'] + 1, len(route['steps']))} 步")
                next_report = elapsed + 10
            if fixed_obstacles is not None:
                assert state['obstacles'] == fixed_obstacles, 'The physical obstacle moved or disappeared'
                assert state['navigation'] == detour_navigation, 'A repeated request changed the chosen detour'
            if state['status'] == 'PAUSED':
                assert state['pause_reason'] == 'obstacle' and not obstacle_seen
                assert state['distance_m'] == 32 and state['obstacle_active']
                obstacle_seen = True
                fixed_obstacles = state['obstacles']
                assert len(fixed_obstacles) == 1
                original_points = state['navigation']['points']
                # The board is 5m ahead of the dog's stopped position, and all
                # prior path vertices survive the future-only replacement.
                expected_obstacle = point_at(original_points, 37)
                assert math.sqrt(sum((expected_obstacle[key] - fixed_obstacles[0]['point'][key]) ** 2 for key in ('x', 'y', 'z'))) < .001
                bypass = await check.action(data, 'obstacle_bypass')
                assert bypass['status'] == 'ACTIVE' and not bypass['obstacle_active'] and bypass['distance_m'] == 32
                assert bypass['obstacles'] == fixed_obstacles and bypass['detour_until_m'] > 46.2
                detour_navigation = bypass['navigation']
                total = detour_navigation['total_distance_m']
                assert total > 150
                assert abs(path_length(detour_navigation['points']) - total) < .001
                assert all(abs(end - step['end_m'] - (total - 150)) < .001
                           for end, step in zip(detour_navigation['step_end_distances'], route['steps']))
                for distance in (0, 10, 29.8, 32):
                    original, updated = point_at(original_points, distance), point_at(detour_navigation['points'], distance)
                    assert all(abs(original[key] - updated[key]) < 1e-8 for key in ('x', 'y', 'z'))
                assert_obstacle_clearance(detour_navigation['points'], fixed_obstacles[0], 32, bypass['detour_until_m'])
                repeated = await check.action(data, 'obstacle_bypass')
                assert repeated['navigation'] == detour_navigation and repeated['obstacles'] == fixed_obstacles
                duplicate = await check.client.post(check.path(data, '/actions'), headers=check.headers(data), json={'action': 'obstacle'})
                assert duplicate.status_code == 409 and duplicate.json()['error'] == 'DETOUR_IN_PROGRESS'
                paused = (await check.text(data, '暂停绕行'))['state']
                assert paused['status'] == 'PAUSED' and paused['pause_reason'] == 'user'
                await asyncio.sleep(0.3)
                refreshed = await check.state(data)
                assert refreshed['distance_m'] == paused['distance_m']
                assert refreshed['navigation'] == detour_navigation and refreshed['obstacles'] == fixed_obstacles
                resumed = await check.action(data, 'resume')
                assert resumed['status'] == 'ACTIVE' and resumed['navigation'] == detour_navigation
                await live.wait(lambda: live.latest['revision'] >= resumed['revision'] and live.latest['status'] == 'ACTIVE')
                report(f'PASS 32m 自动遇障；障碍原位保留；真实弧长增至 {total:.4f}m；重复绕行不扩路；人狗沿同路径绕过；暂停/刷新/继续')
            elif state['status'] == 'DONE':
                assert obstacle_seen
                total = state['navigation']['total_distance_m']
                assert state['distance_m'] == total and state['current_step'] == len(route['steps'])
                assert state['detour_until_m'] is None
                snapshot = await check.state(data)
                assert snapshot['status'] == 'DONE' and snapshot['distance_m'] == total
                assert snapshot['obstacles'] == fixed_obstacles
                assert elapsed >= total / route['speed_mps'] - .3, 'Route ran faster than the real 1.2 m/s simulation'
                assert live.pongs >= 8, 'Periodic JSON heartbeats did not receive enough replies'
                reset = await check.action(data, 'reset')
                assert reset['status'] == 'IDLE' and reset['obstacles'] == [] and reset['distance_m'] == 0
                assert reset['navigation']['points'] == route['points'] and reset['navigation']['total_distance_m'] == 150
                report(f'PASS 完整路线 DONE，{total:.4f}m / {len(route["steps"])}步，实际耗时 {elapsed:.1f}s，障碍到终点仍保留，reset才清除，JSON 心跳持续正常')
                break
            else:
                assert state['status'] == 'ACTIVE'
            await asyncio.sleep(0.2)


def path_length(points):
    return sum(math.sqrt(sum((b[key] - a[key]) ** 2 for key in ('x', 'y', 'z'))) for a, b in zip(points, points[1:]))


def point_at(points, distance):
    for a, b in zip(points, points[1:]):
        length = path_length([a, b])
        if distance <= length:
            return {key: a[key] + (b[key] - a[key]) * distance / length for key in ('x', 'y', 'z')}
        distance -= length
    return points[-1]


def assert_obstacle_clearance(points, obstacle, start, until):
    # Check both actor centres against the fixed 1.45m x .35m board footprint.
    # This independently verifies the API geometry, not the browser rendering.
    heading, centre = obstacle['heading'], obstacle['point']
    for sample in range(301):
        dog_distance = start + (until - start) * sample / 300
        for distance in (dog_distance, max(0, dog_distance - 2.2)):
            point = point_at(points, distance)
            dx, dz = point['x'] - centre['x'], point['z'] - centre['z']
            across = dx * math.cos(heading) - dz * math.sin(heading)
            along = dx * math.sin(heading) + dz * math.cos(heading)
            clearance = math.hypot(max(0, abs(across) - .725), max(0, abs(along) - .175))
            assert clearance >= .65, f'Actor path overlaps the fixed obstacle: {clearance:.3f}m'


async def run(args):
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        check = Check(args.base_url, client)
        try:
            health = await client.get(check.base_url + '/api/demo/health')
            health.raise_for_status()
            assert health.json()['data']['mode'] == 'simulation'
            await basic(check)
            if args.full_route:
                await full_route(check)
            report('全部真实入口检查通过。测试会话已结束；未读取浏览器存储。')
        finally:
            await check.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base_url', nargs='?', default='http://localhost:3000')
    parser.add_argument('--full-route', action='store_true', help='Run the full 150 m route at 1.2 m/s (about 2 minutes)')
    args = parser.parse_args()
    parts = urlsplit(args.base_url)
    if parts.scheme not in {'http', 'https'} or not parts.netloc or parts.query or parts.fragment or parts.username:
        parser.error('base_url must be an HTTP(S) origin or path without credentials, query, or fragment')
    asyncio.run(run(args))


if __name__ == '__main__':
    main()
