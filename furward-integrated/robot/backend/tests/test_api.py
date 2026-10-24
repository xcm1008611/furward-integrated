import pytest
from fastapi.testclient import TestClient
from app.config import get_settings
from app.main import create_app


@pytest.fixture
def client(settings):
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as client:
        yield client


def test_health_state_and_mode(client):
    data = client.get('/api/health').json()['data']
    assert data['robot_online'] and data['robot_backend'] == 'mock'
    assert data['mode'] == 'indoor' and data['uptime_s'] >= 0
    assert client.get('/api/tasks/current').json()['data'] is None
    assert client.get('/api/robot/state').json()['data']['battery'] == 90
    assert client.post('/api/mode', json={'mode': 'outdoor'}).json()['data']['mode'] == 'outdoor'
    assert client.get('/api/mode').json()['data']['mode'] == 'outdoor'
    result = client.post('/api/robot/command', json={'name': 'move', 'args': {'distance_m': 1}})
    assert result.status_code == 403
    assert result.json() == {'ok': False, 'error': 'MODE_FORBIDDEN', 'message': '室外演示模式下机器狗不移动'}


def test_busy_switch_and_stop(client):
    assert client.post('/api/robot/command', json={'name': 'speak', 'args': {'text': '字' * 100}}).json()['ok']
    assert client.post('/api/mode', json={'mode': 'outdoor'}).json()['error'] == 'ROBOT_BUSY'
    assert client.post('/api/robot/command', json={'name': 'stand_up'}).json()['error'] == 'ROBOT_BUSY'
    result = client.post('/api/robot/stop').json()['data']
    assert result['task']['status'] == 'CANCELLED'
    assert client.get('/api/tasks/current').json()['data']['status'] == 'CANCELLED'
    assert client.post('/api/mode', json={'mode': 'outdoor'}).json()['ok']


@pytest.mark.parametrize('path,body', [('/api/mode', {'mode': 'bad'}), ('/api/robot/command', {'args': {}}), ('/api/robot/command', {'name': 'move', 'args': []})])
def test_validation_format(client, path, body):
    response = client.post(path, json=body)
    assert response.status_code == 422
    assert response.json() == {'ok': False, 'error': 'INVALID_ARGS', 'message': '请求参数不合法'}


def test_ws_hello_task_and_ping(client):
    with client.websocket_connect('/ws/app') as ws:
        hello = ws.receive_json()
        assert hello['type'] == 'hello' and hello['data']['mode'] == 'indoor'
        assert isinstance(hello['ts'], float)
        ws.send_json({'type': 'ping'})
        for _ in range(20):
            if ws.receive_json()['type'] == 'pong':
                break
        else:
            pytest.fail('未收到 pong')
        response = client.post('/api/robot/command', json={'name': 'stand_up'})
        task_id = response.json()['data']['id']
        for _ in range(30):
            event = ws.receive_json()
            if event['type'] == 'task.update' and event['data']['status'] == 'DONE':
                assert event['data']['id'] == task_id
                break
        else:
            pytest.fail('未收到任务完成事件')
    assert not client.app.state.bus._subscribers


def test_cors_and_not_found(client):
    response = client.options('/api/robot/command', headers={'origin': 'http://phone.test', 'access-control-request-method': 'POST'})
    assert response.headers['access-control-allow-origin'] == '*'
    assert client.get('/missing').json()['error'] == 'NOT_FOUND'
