import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import Command, Task, TaskStatus
from app.events import EventBus
from app.services.modes import ModeService
from app.services.scheduler import Scheduler, StatePublisher
from app.robot.bridge_client import BridgeRobot
from test_bridge import config, Socket
from test_assistant import FakeLLM
from app.services.llm import LLMResult, ToolCall


@pytest.mark.parametrize('endpoint,body', [
    ('/api/robot/command', {'name': 'stand_up'}),
    ('/api/robot/prepare', None),
    ('/api/nav/execute', None),
])
def test_offline_rejected_before_queue(endpoint, body):
    app = create_app(config())
    with TestClient(app) as client:
        assert client.post('/api/nav/plan', json={'mode': 'indoor', 'to': 'door'}).json()['ok']
        response = client.post(endpoint, json=body)
        assert response.status_code == 503
        assert response.json() == {'ok': False, 'error': 'ROBOT_OFFLINE', 'message': '机器狗未连接'}
        assert app.state.scheduler.current() is None
        assert app.state.navigation.status == 'IDLE'
        assert app.state.scheduler.reserved_source is None


@pytest.mark.parametrize('text', ['站起来', '准备出发', '开始导航'])
def test_assistant_offline_reply(text):
    app = create_app(config())
    with TestClient(app) as client:
        client.post('/api/nav/plan', json={'mode': 'indoor', 'to': 'door'})
        if text == '开始导航':
            app.state.assistant.llm = FakeLLM(LLMResult(tool_calls=[ToolCall('nav_execute')]))
        reply = client.post('/api/voice/text', json={'text': text}).json()['data']
        assert reply['text'] == '机器狗未连接'
        assert reply['executed'][0]['error'] == 'ROBOT_OFFLINE'
        assert app.state.scheduler.current() is None


def test_offline_stop_still_attempted_and_logged():
    app = create_app(config())
    with TestClient(app) as client:
        queue = app.state.bus.subscribe()
        app.state.gateway.stop = AsyncMock(wraps=app.state.gateway.stop)
        assert client.post('/api/robot/stop').json()['ok']
        assert client.post('/api/robot/command', json={'name': 'stop'}).json()['data']['status'] == 'DONE'
        assert app.state.gateway.stop.await_count == 2
        logs = []
        while not queue.empty():
            event = queue.get_nowait()
            if event['type'] == 'log':
                logs.append(event['data']['text'])
        assert logs.count('机器狗离线，无法下发停止，请用遥控器') == 2
        assert logs.count('已执行停止') == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('disconnect', [True, False])
@pytest.mark.parametrize('active', [True, False])
async def test_offline_state_ignores_bridge_busy(disconnect, active):
    settings = config()
    bus = EventBus()
    robot = BridgeRobot(settings)
    scheduler = Scheduler(robot, ModeService(bus), settings, bus)
    publisher = StatePublisher(robot, scheduler, bus)
    ws = Socket()
    await robot.attach(ws)
    await robot.receive(ws, {'type': 'state', 'battery': 73, 'action': 'QUAD_MIMIC_GREET',
                             'busy': True, 'current_command': 'mimic', 'action_status': 'RUNNING'})
    assert (await publisher.get_state()).stale is False
    if disconnect:
        await robot.detach(ws)
    else:
        robot._last_seen = 0
    if active:
        scheduler._current = Task(name='移动', steps=[Command(name='move', args={'distance_m': 1})], status=TaskStatus.RUNNING)
    state = await publisher.get_state()
    assert state.stale and not state.online
    assert state.busy is active
    assert state.current_command == ('move' if active else None)
    assert state.action_status == 'UNKNOWN'
    assert state.battery == 73 and state.action == 'QUAD_MIMIC_GREET'
    queue = bus.subscribe()
    publisher.start()
    try:
        event = await asyncio.wait_for(queue.get(), 1)
        assert event['type'] == 'robot.state'
        assert event['data'] == state.model_dump(mode='json')
    finally:
        await publisher.close()
    await robot.attach(Socket())
    assert (await publisher.get_state()).stale is False


def test_rest_state_matches_publisher_after_disconnect():
    app = create_app(config())
    with TestClient(app) as client:
        ws = Socket()
        client.portal.call(app.state.gateway.attach, ws)
        client.portal.call(app.state.gateway.receive, ws, {'type': 'state', 'battery': 73,
                           'action': 'QUAD_MIMIC_GREET', 'busy': True, 'current_command': 'mimic'})
        assert client.get('/api/robot/state').json()['data']['stale'] is False
        client.portal.call(app.state.gateway.detach, ws)
        actual = client.get('/api/robot/state').json()['data']
        expected = client.portal.call(app.state.state_publisher.get_state).model_dump(mode='json')
        assert actual == expected
        assert actual['stale'] and not actual['busy'] and actual['current_command'] is None
        assert actual['action_status'] == 'UNKNOWN' and actual['battery'] == 73
