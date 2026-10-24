import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from demo_service.engine import HEARTBEAT_TIMEOUT, Config, DemoError, Registry, World
from demo_service.main import create_app


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def world_path(tmp_path):
    path = tmp_path / 'route.json'
    path.write_text(json.dumps({
        'version': 1, 'coordinate_system': 'Y-up metres',
        'route': {'route_id': 'demo-city', 'total_distance_m': 150, 'speed_mps': 1.2,
                  'start_name': '西街口', 'destination_name': '街心花园', 'obstacle_distance_m': 32,
                  'points': [{'x': 0, 'y': 0, 'z': 0}, {'x': 100, 'y': 0, 'z': 0}, {'x': 100, 'y': 0, 'z': 50}],
                  'steps': [{'index': 0, 'instruction': '向东走100米', 'start_m': 0, 'end_m': 100, 'distance_m': 100},
                            {'index': 1, 'instruction': '向南走50米', 'start_m': 100, 'end_m': 150, 'distance_m': 50}]},
        'assets': {}, 'transform': {}, 'map': {}, 'detour_blockers': [],
    }), encoding='utf-8')
    return path


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def registry(world_path, clock):
    return Registry(World.load(world_path), Config(run_ticker=False), clock)


@pytest.fixture
def client(world_path, clock):
    with TestClient(create_app(world_path, Config(run_ticker=False), clock)) as client:
        yield client


def create(registry, connected=True):
    data = registry.create()
    session = registry.authenticate(data['session_id'], data['token'])
    queue = registry.attach(session) if connected else None
    return session, queue, data


def advance_connected(registry, clock, seconds):
    """Advance a route with the same 5s application heartbeat as the browser."""
    while seconds > 0:
        step = min(seconds, 5)
        clock.advance(step)
        for session in tuple(registry.sessions.values()):
            for queue in tuple(session.subscribers):
                registry.heartbeat(session, queue)
        registry.tick()
        seconds -= step


def api_create(client):
    response = client.post('/api/demo/sessions')
    assert response.status_code == 200
    data = response.json()['data']
    return data, {'Authorization': 'Bearer ' + data['token']}


def test_two_visitors_are_isolated(registry, clock):
    a, qa, _ = create(registry)
    b, qb, _ = create(registry)
    registry.action(a, 'start')
    registry.action(b, 'start')
    clock.advance(5)
    registry.tick()
    registry.action(a, 'pause')
    assert a.distance_m == pytest.approx(6)
    clock.advance(5)
    registry.tick()
    assert a.distance_m == pytest.approx(6)
    assert b.distance_m == pytest.approx(12)
    registry.action(a, 'cancel')
    assert b.status == 'ACTIVE'
    assert all(item['session_id'] == a.session_id for item in list(qa._queue))
    assert all(item['session_id'] == b.session_id for item in list(qb._queue))


def test_automatic_obstacle_resume_plans_bypass_without_removing_obstacle(registry, clock):
    session, _, _ = create(registry)
    registry.action(session, 'start')
    advance_connected(registry, clock, 30)
    assert session.distance_m == 32
    assert (session.status, session.pause_reason) == ('PAUSED', 'obstacle')
    obstacle = session.snapshot()['obstacles']
    advance_connected(registry, clock, 5)
    assert session.distance_m == 32 and session.status == 'PAUSED'
    registry.action(session, 'resume')
    assert session.navigation['total_distance_m'] > 150 and session.detour_until_m > 44
    clock.advance(10)
    registry.tick()
    assert session.distance_m == pytest.approx(44)
    assert session.obstacle_triggered and not session.obstacle_active
    assert session.obstacles == obstacle


def test_cancel_preserves_position_and_reset_rearms_obstacle(registry, clock):
    session, _, _ = create(registry)
    registry.action(session, 'start')
    clock.advance(10)
    registry.action(session, 'cancel')
    assert session.status == 'CANCELLED' and session.distance_m == pytest.approx(12)
    clock.advance(100)
    registry.tick()
    assert session.distance_m == pytest.approx(12)
    with pytest.raises(DemoError):
        registry.action(session, 'resume')
    registry.attach(session)
    registry.action(session, 'reset')
    assert session.distance_m == 0 and session.status == 'IDLE'
    registry.action(session, 'start')
    advance_connected(registry, clock, 30)
    assert session.status == 'PAUSED' and session.obstacle_active


def test_manual_obstacle_and_repeat_actions(registry, clock):
    session, _, _ = create(registry)
    with pytest.raises(DemoError):
        registry.action(session, 'obstacle')
    registry.action(session, 'start')
    registry.action(session, 'start')
    clock.advance(2)
    registry.action(session, 'obstacle')
    assert session.distance_m == pytest.approx(2.4)
    registry.action(session, 'pause')
    assert session.pause_reason == 'obstacle'
    registry.action(session, 'obstacle_clear')
    registry.action(session, 'resume')
    registry.action(session, 'resume')
    advance_connected(registry, clock, 30)
    assert session.distance_m > 32 and session.status == 'ACTIVE'


def test_arrival_clamps_to_end_and_requires_reset(registry, clock):
    session, _, _ = create(registry)
    registry.action(session, 'start')
    registry.action(session, 'obstacle')
    registry.action(session, 'obstacle_clear')
    registry.action(session, 'resume')
    advance_connected(registry, clock, 1000)
    assert session.status == 'DONE' and session.distance_m == session.navigation['total_distance_m'] and session.current_step == 2
    assert '街心花园' in session.message
    with pytest.raises(DemoError):
        registry.action(session, 'start')
    registry.action(session, 'cancel')
    assert session.status == 'DONE'


def test_disconnect_grace_is_bounded_and_reconnection_does_not_auto_resume(registry, clock):
    session, queue, data = create(registry)
    registry.action(session, 'start')
    clock.advance(2)
    registry.tick()
    registry.detach(session, queue)
    clock.advance(40)
    registry.tick()
    assert session.distance_m == pytest.approx(14.4)
    assert session.status == 'PAUSED' and session.pause_reason == 'disconnected'
    registry.authenticate(data['session_id'], data['token'])
    reconnect = registry.attach(session)
    assert reconnect.get_nowait()['status'] == 'PAUSED'
    registry.action(session, 'resume')
    clock.advance(2)
    registry.tick()
    assert session.distance_m == pytest.approx(16.8)


def test_one_of_two_sockets_disconnect_does_not_pause(registry, clock):
    session, first, _ = create(registry)
    second = registry.attach(session)
    registry.action(session, 'start')
    registry.detach(session, first)
    advance_connected(registry, clock, 15)
    assert session.status == 'ACTIVE' and session.distance_m == 18
    registry.detach(session, second)


def test_http_only_run_pauses_without_ws(registry, clock):
    session, _, _ = create(registry, connected=False)
    registry.action(session, 'start')
    clock.advance(15)
    registry.tick()
    assert session.distance_m == 12 and session.pause_reason == 'disconnected'


def test_expiry_closes_subscriptions_and_frees_capacity(world_path, clock):
    registry = Registry(World.load(world_path), Config(max_sessions=1, ttl_s=30, heartbeat_timeout_s=60), clock)
    session, queue, data = create(registry)
    queue.get_nowait()
    with pytest.raises(DemoError) as exc:
        registry.create()
    assert exc.value.code == 'SESSION_LIMIT'
    clock.advance(20)
    registry.heartbeat(session, queue)
    clock.advance(20)
    registry.sweep()
    assert session.session_id in registry.sessions
    clock.advance(10)
    registry.tick()
    assert queue.get_nowait() is None
    with pytest.raises(DemoError) as exc:
        registry.authenticate(data['session_id'], data['token'])
    assert exc.value.code == 'NOT_FOUND'
    assert registry.create()['session_id'] != data['session_id']


def test_tokens_are_distinct_and_cannot_cross_sessions(registry):
    _, _, a = create(registry)
    _, _, b = create(registry)
    assert a['token'] != b['token']
    with pytest.raises(DemoError) as exc:
        registry.authenticate(a['session_id'], b['token'])
    assert exc.value.code == 'AUTH'


def test_http_contract_validation_and_no_robot_endpoints(client):
    data, headers = api_create(client)
    url = '/api/demo/sessions/' + data['session_id']
    assert client.get(url).status_code == 401
    assert client.get(url, headers=headers).json()['data']['status'] == 'IDLE'
    bad = client.post(url + '/actions', headers=headers, json={'action': 'fly'})
    assert bad.status_code == 422 and bad.json()['error'] == 'INVALID_ARGS'
    assert client.post(url + '/actions', headers=headers, json={'action': 'resume'}).status_code == 409
    assert client.get('/api/demo/world').json()['data']['route']['total_distance_m'] == 150
    assert client.get('/api/demo/health').json()['data']['mode'] == 'simulation'
    for path in ('/api/robot/stop', '/api/robot/command', '/api/voice/text', '/debug', '/showcase', '/ws/bridge', '/docs', '/openapi.json'):
        assert client.get(path).status_code == 404


def test_text_keywords_have_same_pause_cancel_distinction(client, clock):
    data, headers = api_create(client)
    url = '/api/demo/sessions/' + data['session_id'] + '/text'
    assert client.post(url, headers=headers, json={'text': '带我去街心花园'}).json()['data']['state']['status'] == 'ACTIVE'
    clock.advance(1)
    assert client.post(url, headers=headers, json={'text': '停一下'}).json()['data']['state']['status'] == 'PAUSED'
    reply = client.post(url, headers=headers, json={'text': '结束导航'}).json()['data']
    assert reply['state']['status'] == 'CANCELLED' and reply['state']['distance_m'] == pytest.approx(1.2)
    assert client.post(url, headers=headers, json={'text': '   '}).status_code == 422
    before = reply['state']['distance_m']
    unknown = client.post(url, headers=headers, json={'text': '前进100米'}).json()['data']
    assert unknown['state']['distance_m'] == before


def test_websocket_initial_state_ping_and_reconnect(client, clock):
    data, headers = api_create(client)
    url = '/api/demo/sessions/' + data['session_id']
    with client.websocket_connect('/ws/demo') as ws:
        ws.send_json({'session_id': data['session_id'], 'token': data['token']})
        first = ws.receive_json()
        assert first['type'] == 'demo.state' and first['data']['status'] == 'IDLE'
        assert isinstance(first['ts'], float)
        ws.send_json({'type': 'ping'})
        assert ws.receive_json()['type'] == 'pong'
        state = client.post(url + '/actions', headers=headers, json={'action': 'start'}).json()['data']
        assert ws.receive_json()['data']['revision'] == state['revision']
    clock.advance(11)
    with client.websocket_connect('/ws/demo') as ws:
        ws.send_json({'session_id': data['session_id'], 'token': data['token']})
        state = ws.receive_json()['data']
        assert state['status'] == 'PAUSED' and state['pause_reason'] == 'disconnected'


@pytest.mark.parametrize('packet', [{}, {'session_id': 'missing', 'token': 'no'}, {'session_id': [], 'token': 'no'}])
def test_websocket_rejects_invalid_first_packet(client, packet):
    with client.websocket_connect('/ws/demo') as ws:
        ws.send_json(packet)
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


def test_websocket_wrong_token(client):
    data, _ = api_create(client)
    with client.websocket_connect('/ws/demo') as ws:
        ws.send_json({'session_id': data['session_id'], 'token': 'wrong'})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


def test_untrusted_origin_rejected_for_http_and_websocket(client):
    data, headers = api_create(client)
    url = '/api/demo/sessions/' + data['session_id']
    bad = client.get(url, headers=headers | {'Origin': 'https://other.example'})
    assert bad.status_code == 403 and bad.json()['error'] == 'ORIGIN_FORBIDDEN'
    assert client.post('/api/demo/sessions', headers={'Origin': 'null'}).status_code == 403
    assert client.get(url, headers=headers | {'Origin': 'http://testserver'}).status_code == 200
    with client.websocket_connect('/ws/demo', headers={'Origin': 'https://other.example'}) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008
    with client.websocket_connect('/ws/demo', headers={'Origin': 'http://testserver'}) as ws:
        ws.send_json({'session_id': data['session_id'], 'token': data['token']})
        assert ws.receive_json()['type'] == 'demo.state'


def test_websocket_requires_auth_within_deadline(world_path, clock):
    with TestClient(create_app(world_path, Config(auth_timeout_s=0.02, run_ticker=False), clock)) as client:
        with client.websocket_connect('/ws/demo') as ws:
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 1008


def test_real_background_ticker_delivers_progress(world_path):
    with TestClient(create_app(world_path)) as client:
        data, headers = api_create(client)
        with client.websocket_connect('/ws/demo') as ws:
            ws.send_json({'session_id': data['session_id'], 'token': data['token']})
            ws.receive_json()
            client.post('/api/demo/sessions/' + data['session_id'] + '/actions', headers=headers, json={'action': 'start'})
            for _ in range(5):
                state = ws.receive_json()['data']
                if state['distance_m'] > 0:
                    break
            assert state['status'] == 'ACTIVE' and state['distance_m'] > 0


def test_two_live_sockets_never_receive_other_visitors_events(client):
    a, ha = api_create(client)
    b, hb = api_create(client)
    with client.websocket_connect('/ws/demo') as wa, client.websocket_connect('/ws/demo') as wb:
        wa.send_json({'session_id': a['session_id'], 'token': a['token']})
        wb.send_json({'session_id': b['session_id'], 'token': b['token']})
        wa.receive_json()
        wb.receive_json()
        client.post('/api/demo/sessions/' + a['session_id'] + '/actions', headers=ha, json={'action': 'start'})
        assert wa.receive_json()['data']['status'] == 'ACTIVE'
        wb.send_json({'type': 'ping'})
        assert wb.receive_json()['type'] == 'pong'  # No leaked state packet from A.
        assert client.get('/api/demo/sessions/' + b['session_id'], headers=hb).json()['data']['status'] == 'IDLE'
        stolen = client.get('/api/demo/sessions/' + a['session_id'], headers=hb)
        assert stolen.status_code == 401 and 'data' not in stolen.json()


def test_expired_live_socket_closes_and_cannot_reconnect(world_path):
    config = Config(ttl_s=0.05, tick_s=0.01)
    with TestClient(create_app(world_path, config)) as client:
        data, headers = api_create(client)
        with client.websocket_connect('/ws/demo') as ws:
            ws.send_json({'session_id': data['session_id'], 'token': data['token']})
            ws.receive_json()
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 1008
        assert client.get('/api/demo/sessions/' + data['session_id'], headers=headers).status_code == 404


def test_registry_close_notifies_and_discards_all_sessions(registry):
    session, queue, _ = create(registry)
    queue.get_nowait()
    registry.close()
    assert queue.get_nowait() is None
    assert registry.sessions == {}



def test_half_open_lease_caps_progress_even_if_tick_is_delayed(registry, clock):
    session, queue, _ = create(registry)
    registry.action(session, 'start')
    clock.advance(100)
    registry.tick()
    assert session.status == 'PAUSED' and session.pause_reason == 'disconnected'
    assert session.distance_m == pytest.approx(30)  # 15s lease + 10s grace, at 1.2m/s.
    assert queue not in session.subscribers
    assert HEARTBEAT_TIMEOUT in list(queue._queue)


def test_each_connection_expires_independently_and_old_socket_cannot_mask_close(registry, clock):
    session, old, _ = create(registry)
    registry.action(session, 'start')
    clock.advance(10)
    fresh = registry.attach(session)
    clock.advance(5)
    registry.heartbeat(session, fresh)
    assert old not in session.subscribers
    assert HEARTBEAT_TIMEOUT in list(old._queue)
    registry.detach(session, fresh)
    clock.advance(11)
    registry.tick()
    assert session.status == 'PAUSED' and session.distance_m == pytest.approx(30)
    assert session.pause_reason == 'disconnected'


def test_stale_heartbeat_cannot_renew_another_connection_or_session_ttl(registry, clock):
    session, old, _ = create(registry)
    clock.advance(10)
    fresh = registry.attach(session)
    clock.advance(6)
    before = session.last_seen
    with pytest.raises(DemoError) as exc:
        registry.heartbeat(session, old)
    assert exc.value.code == 'CONNECTION_TIMEOUT'
    assert session.last_seen == before
    assert fresh in session.subscribers and old not in session.subscribers


def test_reconnect_before_deadline_preserves_progress_without_fresh_run(registry, clock):
    session, queue, _ = create(registry)
    registry.action(session, 'start')
    clock.advance(16)
    registry.tick()
    assert queue not in session.subscribers and session.status == 'ACTIVE'
    registry.attach(session)
    advance_connected(registry, clock, 5)
    assert session.status == 'ACTIVE' and session.distance_m == pytest.approx(25.2)


def test_http_activity_does_not_renew_socket_lease(registry, clock):
    session, queue, data = create(registry)
    registry.action(session, 'start')
    for _ in range(5):
        clock.advance(5)
        registry.authenticate(data['session_id'], data['token'])
    assert session.status == 'PAUSED' and session.pause_reason == 'disconnected'
    assert queue not in session.subscribers


def test_socket_heartbeat_timeout_closes_with_recoverable_code(world_path):
    with TestClient(create_app(world_path, Config(heartbeat_timeout_s=0.06, tick_s=0.01))) as client:
        data, headers = api_create(client)
        with client.websocket_connect('/ws/demo') as ws:
            ws.send_json({'session_id': data['session_id'], 'token': data['token']})
            ws.receive_json()
            ws.send_json({'type': 'ignored'})  # Other traffic must not renew the lease.
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 4000
        assert client.get('/api/demo/sessions/' + data['session_id'], headers=headers).status_code == 200
