import asyncio
import math
from time import monotonic

import httpx
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from app.config import Settings
from app.errors import ApiError
from app.main import create_app
from app.models import Command, DemoMode, NavPlanRequest
from app.services.amap import AmapClient
from app.services.indoor import IndoorMap
from app.services.navigation import NavigationService
from app.services.scheduler import StatePublisher
from app.services.sequences import prepare_sequence


async def until(predicate, timeout=3):
    deadline = monotonic() + timeout
    while not predicate():
        if monotonic() > deadline:
            pytest.fail('等待状态超时')
        await asyncio.sleep(0.001)


@pytest_asyncio.fixture
async def nav(components, settings):
    robot, modes, scheduler, bus = components
    await robot.connect()
    amap = AmapClient(settings, httpx.MockTransport(lambda r: httpx.Response(503)))
    service = NavigationService(settings, scheduler, modes, bus, IndoorMap(settings), amap)
    yield service
    await service.close()
    await scheduler.close()
    await amap.close()


async def plan_indoor(nav, destination='door'):
    return await nav.plan(NavPlanRequest(mode='indoor', to=destination))


@pytest.mark.asyncio
async def test_execute_done_and_progress(nav):
    queue = nav.bus.subscribe()
    route = await plan_indoor(nav)
    await nav.execute()
    await until(lambda: nav.status == 'DONE')
    assert nav.pose == pytest.approx((*route.polyline[-1], 0), abs=1e-6)
    assert nav.waypoint == 'door'
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    progress = [e['data'] for e in events if e['type'] == 'nav.progress']
    assert progress[-1]['remaining_m'] == 0
    assert progress[-1]['current_step'] == len(route.steps)
    assert nav.scheduler.current().steps[0].args['text'] == '已到达门口'
    await until(lambda: not nav.scheduler.busy)
    back = await plan_indoor(nav, 'start')
    assert back.polyline[0] == route.polyline[-1]


@pytest.mark.asyncio
@pytest.mark.parametrize('reason', ['user', 'obstacle', 'stop'])
async def test_pause_remaining_and_resume(nav, reason):
    await plan_indoor(nav, 'desk')
    await nav.execute()
    await until(lambda: nav.scheduler.gateway._active == 'move')
    await asyncio.sleep(0.02)
    if reason == 'stop':
        result = await nav.scheduler.stop()
    else:
        await nav.pause(reason)
        result = {'completed_ratio': nav.scheduler.current().completed_ratio}
    ratio = result['completed_ratio']
    assert 0 < ratio < 1
    assert nav.scheduler.current().cancel_reason == reason
    assert nav.status == 'PAUSED' and nav.pause_reason == reason
    assert nav._pending[0][0].args['distance_m'] == pytest.approx(2*(1-ratio))
    assert nav.pose[0] == pytest.approx(0.5 + 2*ratio)
    await nav.resume()
    await until(lambda: nav.status == 'DONE')
    assert nav.pose[:2] == pytest.approx((2.5, 0.5))


@pytest.mark.asyncio
async def test_turn_pause_and_resume(nav):
    await plan_indoor(nav, 'coffee')
    await nav.execute()
    await until(lambda: nav.scheduler.gateway._active == 'turn')
    await asyncio.sleep(0.01)
    await nav.pause()
    ratio = nav.scheduler.current().completed_ratio
    assert nav.pose[2] == pytest.approx(90*ratio)
    assert nav._pending[0][0].args['angle_deg'] == pytest.approx(90*(1-ratio))
    await nav.resume()
    await until(lambda: nav.status == 'DONE')
    assert nav.pose == pytest.approx((2.5, 3.5, 90))


@pytest.mark.asyncio
async def test_stop_between_commands_and_immediately(nav):
    nav.settings.nav_settle_s = 5
    await plan_indoor(nav, 'coffee')
    await nav.execute()
    await nav.scheduler.stop()
    assert nav.status == 'PAUSED' and nav.pause_reason == 'stop'
    await nav.resume()
    await until(lambda: nav.pose[0] == 2.5 and nav._active_task is None)
    await nav.scheduler.stop()
    assert nav.status == 'PAUSED'
    assert nav._pending[0][0].name == 'turn'
    await nav.resume()
    await until(lambda: nav.status == 'DONE')
    assert nav.pose == pytest.approx((2.5, 3.5, 90))


@pytest.mark.asyncio
async def test_cancel_failure_and_mode_guards(nav):
    queue = nav.bus.subscribe()
    await plan_indoor(nav)
    nav.scheduler.gateway._fail.add('move')
    await nav.execute()
    await until(lambda: nav.status == 'FAILED')
    assert any(queue.get_nowait()['type'] == 'log' for _ in range(queue.qsize()))
    nav.scheduler.gateway._fail.clear()
    await plan_indoor(nav)
    await nav.execute()
    with pytest.raises(ApiError) as caught:
        await nav.modes.set_mode(DemoMode.OUTDOOR)
    assert caught.value.code == 'ROBOT_BUSY'
    await nav.cancel()
    assert nav.status == 'CANCELLED' and not nav._pending
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    with pytest.raises(ApiError) as caught:
        await nav.execute()
    assert caught.value.code == 'MODE_FORBIDDEN'
    with pytest.raises(ApiError) as caught:
        await plan_indoor(nav)
    assert caught.value.code == 'MODE_FORBIDDEN'


@pytest.mark.asyncio
async def test_progress_interpolation(nav):
    nav.settings.mock_time_scale = 0.1
    nav.settings.nav_progress_interval_s = 0.01
    await nav.scheduler.gateway.stand_up()
    await plan_indoor(nav, 'desk')
    await nav.execute()
    await until(lambda: nav.pose[0] > 0.5)
    assert 0.5 < nav.pose[0] < 2.5
    await nav.pause()
    assert nav.pose[0] == pytest.approx(0.5 + 2*nav.scheduler.current().completed_ratio)


@pytest.mark.asyncio
async def test_repeat_busy_only_event(nav):
    await plan_indoor(nav)
    await nav.scheduler.submit('播报', [Command(name='speak', args={'text': '字'*100})])
    current_id = nav.scheduler.current().id
    queue = nav.bus.subscribe()
    await nav.repeat()
    assert nav.scheduler.current().id == current_id
    assert queue.get_nowait()['type'] == 'nav.progress'


@pytest.mark.asyncio
async def test_outdoor_fallback_location_and_default_origin(nav):
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    nav.settings.outdoor_default_origin = '121.5901,31.2032'
    route = await nav.plan(NavPlanRequest(mode='outdoor', destination='占位演示'))
    assert route.cached and route.sample and route.note
    with pytest.raises(ApiError) as caught:
        await nav.plan(NavPlanRequest(mode='outdoor', destination='不匹配'))
    assert caught.value.code == 'UPSTREAM_ERROR'
    with pytest.raises(ApiError):
        await nav.update_location(500, 31)
    await nav.update_location(*route.steps[0].end)
    assert nav.status == 'DONE'


@pytest.mark.asyncio
async def test_outdoor_wgs84_conversion(nav, monkeypatch):
    from app.services.coords import wgs84_to_gcj02
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    origins = []
    async def walking(origin, destination):
        origins.append(origin)
        return {'mode': 'outdoor', 'coord': 'gcj02', 'polyline': [origin, destination]}
    monkeypatch.setattr(nav.amap, 'walking', walking)
    await nav.plan(NavPlanRequest(mode='outdoor', origin=(121.47, 31.23), origin_coord='wgs84', destination=(121.5, 31.3)))
    assert origins[-1] == wgs84_to_gcj02(121.47, 31.23)
    nav.settings.outdoor_default_origin = '121.47,31.23'
    await nav.plan(NavPlanRequest(mode='outdoor', origin_coord='wgs84', destination=(121.5, 31.3)))
    assert origins[-1] == (121.47, 31.23)


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['state', 'publish', 'log'])
async def test_state_publisher_survives_exceptions(components, monkeypatch, failure):
    robot, modes, scheduler, bus = components
    publisher = StatePublisher(robot, scheduler, bus, 0.001)
    queue = bus.subscribe()
    calls = 0
    original_state, original_publish = robot.get_state, bus.publish
    async def state():
        nonlocal calls
        calls += 1
        if calls == 1 and failure in {'state', 'log'}:
            raise RuntimeError('模拟离线')
        return await original_state()
    async def publish(kind, data, **kwargs):
        if failure == 'publish' and kind == 'robot.state' and calls == 1:
            raise RuntimeError('模拟推送异常')
        if failure == 'log' and kind == 'log':
            raise RuntimeError('模拟日志异常')
        await original_publish(kind, data, **kwargs)
    monkeypatch.setattr(robot, 'get_state', state)
    monkeypatch.setattr(bus, 'publish', publish)
    publisher.start()
    try:
        await until(lambda: calls >= 3)
    finally:
        await publisher.close()
    events = [queue.get_nowait() for _ in range(queue.qsize())]
    assert any(e['type'] == 'robot.state' for e in events)
    if failure != 'log':
        assert any(e['type'] == 'log' and e['data']['stage'] == 'error' for e in events)


def test_nav_api_and_external_stop(settings):
    with TestClient(create_app(settings)) as client:
        assert client.get('/api/indoor/map').json()['data']['start_waypoint'] == 'start'
        assert client.post('/api/nav/plan', json={'mode': 'indoor', 'to': '服务台'}).json()['ok']
        assert client.post('/api/nav/execute').json()['ok']
        assert client.post('/api/robot/stop').json()['ok']
        data = client.get('/api/nav/current').json()['data']
        assert data['status'] == 'PAUSED' and data['pause_reason'] == 'stop'
        assert client.post('/api/nav/resume').json()['ok']
        assert client.post('/api/nav/cancel').json()['data']['status'] == 'CANCELLED'
        client.post('/api/mode', json={'mode': 'outdoor'})
        assert client.post('/api/nav/execute').json()['error'] == 'MODE_FORBIDDEN'
        missing = client.post('/api/nav/plan', json={'mode': 'outdoor', 'destination': '目的地'})
        assert missing.json()['error'] == 'INVALID_ARGS'
        error = client.post('/api/nav/plan', json={'mode': 'outdoor', 'origin': [121, 31], 'destination': '无缓存'})
        assert error.json() == {'ok': False, 'error': 'UPSTREAM_ERROR', 'message': '未配置高德 Key'}
        assert client.post('/api/nav/pause', json={'reason': 'bad'}).json()['error'] == 'INVALID_ARGS'


def test_prepare_outdoor_api(settings):
    with TestClient(create_app(settings)) as client:
        client.post('/api/mode', json={'mode': 'outdoor'})
        with client.websocket_connect('/ws/app') as ws:
            ws.receive_json()
            response = client.post('/api/robot/prepare').json()
            assert response['ok'] and response['data']['source'] == 'sequence'
            observed = []
            while True:
                event = ws.receive_json()
                if event['type'] == 'task.update':
                    task = event['data']
                    if task['status'] == 'RUNNING':
                        observed.append(task['steps'][task['current_step']]['name'])
                    if task['status'] == 'DONE':
                        break
            assert observed == ['stand_up', 'led', 'mimic', 'speak', 'mimic']
        again = client.post('/api/robot/prepare').json()['data']
        assert [c['name'] for c in again['steps']] == ['led', 'mimic', 'speak', 'mimic']


def test_prepare_summary_limit(settings):
    route = IndoorMap(settings).plan('start', 'door', 0)
    route.steps[0].instruction = '长'*200
    commands = prepare_sequence(route)
    text = next(c.args['text'] for c in commands if c.name == 'speak')
    assert len(text) == 100 and text.startswith('路线已规划，全程约')
    assert '第一步' in text


@pytest.mark.asyncio
async def test_stop_during_start_does_not_start_motion(nav, monkeypatch):
    await plan_indoor(nav)
    entered, release = asyncio.Event(), asyncio.Event()
    original = nav.scheduler.gateway.get_state
    async def delayed_state():
        entered.set()
        await release.wait()
        return await original()
    monkeypatch.setattr(nav.scheduler.gateway, 'get_state', delayed_state)
    start = asyncio.create_task(nav.execute())
    await entered.wait()
    await nav.scheduler.stop()
    release.set()
    with pytest.raises(ApiError) as caught:
        await start
    assert caught.value.code == 'CANCELLED'
    assert nav.scheduler.current() is None


@pytest.mark.asyncio
async def test_cancel_during_plan_does_not_replace_route(nav, monkeypatch):
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    entered, release = asyncio.Event(), asyncio.Event()
    async def walking(origin, destination):
        entered.set()
        await release.wait()
        return {'mode': 'outdoor', 'coord': 'gcj02'}
    monkeypatch.setattr(nav.amap, 'walking', walking)
    planning = asyncio.create_task(nav.plan(NavPlanRequest(mode='outdoor', origin=(121, 31), destination=(122, 32))))
    await entered.wait()
    await nav.cancel()
    release.set()
    with pytest.raises(ApiError) as caught:
        await planning
    assert caught.value.code == 'CANCELLED'
    assert nav.status == 'CANCELLED' and nav.route is None


@pytest.mark.asyncio
async def test_arrival_speech_after_busy_task(nav):
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    await nav.plan(NavPlanRequest(mode='outdoor', origin=(121, 31), destination='占位演示'))
    task = await nav.scheduler.submit('播报', [Command(name='speak', args={'text': '字'*30})])
    await nav.next()
    assert nav.status == 'DONE'
    await until(lambda: nav.scheduler.current().id != task.id)
    assert nav.scheduler.current().steps[0].args['text'] == '已到达张江占位演示终点'


@pytest.mark.asyncio
async def test_gap_rejects_unrelated_commands(nav):
    nav.settings.nav_settle_s = 5
    await plan_indoor(nav, 'coffee')
    await nav.execute()
    await until(lambda: nav.pose[0] == 2.5 and nav._active_task is None)
    with pytest.raises(ApiError) as caught:
        await nav.scheduler.submit('插入', [Command(name='turn', args={'angle_deg': 90})])
    assert caught.value.code == 'ROBOT_BUSY'
    with pytest.raises(ApiError) as caught:
        await nav.modes.set_mode(DemoMode.OUTDOOR)
    assert caught.value.code == 'ROBOT_BUSY'
    await nav.repeat()
    await until(lambda: nav.status == 'DONE')


@pytest.mark.asyncio
async def test_upstream_failure_cache_and_corrupt_cache(nav, tmp_path):
    nav.settings.amap_key = 'test'
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    route = await nav.plan(NavPlanRequest(mode='outdoor', origin=(121, 31), destination='占位演示'))
    assert route.cached
    (tmp_path / 'broken.json').write_text('{', encoding='utf-8')
    nav.settings.demo_routes_dir = str(tmp_path)
    with pytest.raises(ApiError) as caught:
        await nav.plan(NavPlanRequest(mode='outdoor', origin=(121, 31), destination='占位演示'))
    assert caught.value.code == 'UPSTREAM_ERROR'


@pytest.mark.asyncio
async def test_resume_skips_tiny_remainders(nav):
    await plan_indoor(nav, 'desk')
    nav.status = 'PAUSED'
    nav.pose = (2.48, 0.5, 0)
    nav._pending = [(Command(name='move', args={'distance_m': 0.02}), 0), (Command(name='turn', args={'angle_deg': 2}), 0)]
    await nav.resume()
    await until(lambda: nav.status == 'DONE')
    assert nav.pose == (2.5, 0.5, 0)
    assert nav.waypoint == 'desk'
    assert nav.current()['remaining_m'] == 0
    assert not nav._pending


@pytest.mark.asyncio
async def test_remaining_current_active_and_paused(nav):
    nav.settings.mock_time_scale = .1
    nav.settings.nav_progress_interval_s = .005
    route = await plan_indoor(nav, 'coffee')
    assert nav.current()['remaining_m'] == route.distance_m
    await nav.execute()
    await until(lambda: nav.scheduler.gateway._active == 'move')
    await asyncio.sleep(.03)
    current = nav.current()['remaining_m']
    assert 0 < current < route.distance_m
    await nav.pause()
    paused = nav.current()['remaining_m']
    # 运动回执和调度器估算使用不同起始时刻，允许毫秒级误差。
    assert 0 < paused <= current + .01
    assert paused == pytest.approx(sum(c.args['distance_m'] for c, _ in nav._pending if c.name == 'move'))
    await asyncio.sleep(.01)
    assert nav.current()['remaining_m'] == paused
    queue = nav.bus.subscribe()
    await nav._progress()
    assert queue.get_nowait()['data']['remaining_m'] == paused


@pytest.mark.asyncio
async def test_mode_clears_route_and_rejects_paused(nav):
    await plan_indoor(nav)
    queue = nav.bus.subscribe()
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    assert nav.route is None and nav.status == 'IDLE'
    events = [queue.get_nowait() for _ in range(queue.qsize())]
    assert any(e['type'] == 'nav.route' and e['data'] is None for e in events)
    assert not any('路线已规划' in c.args.get('text', '') for c in prepare_sequence(nav.route))
    await nav.modes.set_mode(DemoMode.INDOOR)
    await plan_indoor(nav)
    await nav.execute()
    for status in ('ACTIVE', 'PAUSED'):
        if status == 'PAUSED':
            await nav.pause()
        with pytest.raises(ApiError) as caught:
            await nav.modes.set_mode(DemoMode.OUTDOOR)
        assert caught.value.code == 'ROBOT_BUSY'
        assert caught.value.message == '导航进行中，请先取消导航'
        assert nav.modes.mode == DemoMode.INDOOR and nav.route is not None
    await nav.cancel()
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    assert nav.route is None and nav.status == 'IDLE'
