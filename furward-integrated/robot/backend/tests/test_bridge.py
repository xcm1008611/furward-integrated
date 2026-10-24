import asyncio
import base64
import math
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import create_app
from app.robot.bridge_client import BridgeRobot

HELLO = {'type': 'hello', 'robot': 'T1', 'adapter': 'mock', 'adapter_ver': '0.6', 'sdk_commit': 'test'}


def next_command(ws):
    while True:
        message = ws.receive_json()
        if message['type'] == 'ping':
            ws.send_json({'type': 'pong'})
        elif message['type'] == 'cmd':
            return message


def config(**kwargs):
    return Settings(_env_file=None, robot_backend='bridge', obstacle_source='none', llm_enabled=False,
                    bridge_ping_interval_s=.03, **kwargs)


def wait_online(client, expected):
    for _ in range(100):
        if client.get('/api/robot/state').json()['data']['online'] is expected:
            return
        time.sleep(.01)
    pytest.fail('连接状态未按预期更新')


def test_roundtrip_calibration_disconnect():
    app = create_app(config(calib_linear_scale=2, calib_angular_scale=.5))
    with TestClient(app) as client:
        with client.websocket_connect('/ws/bridge') as ws:
            ws.send_json(HELLO)
            wait_online(client, True)
            future = client.portal.start_task_soon(app.state.gateway.move, 1.2)
            cmd = next_command(ws)
            assert cmd['name'] == 'move' and cmd['args']['speed_mps'] == .3
            assert cmd['args']['duration_s'] == pytest.approx(2)
            ws.send_json({'type': 'result', 'id': cmd['id'], 'ok': True, 'detail': {'duration_s': 2}})
            assert future.result(2).ok
            turn = client.portal.start_task_soon(app.state.gateway.turn, -90)
            cmd = next_command(ws)
            assert cmd['args']['angular_speed'] == -.5
            assert cmd['args']['duration_s'] == pytest.approx(math.pi * 2)
            ws.send_json({'type': 'result', 'id': cmd['id'], 'ok': True})
            assert turn.result(2).ok
            pending = client.portal.start_task_soon(app.state.gateway.stand_up)
            next_command(ws)
        assert pending.result(2).error == 'ROBOT_OFFLINE'
        wait_online(client, False)
        assert client.portal.call(app.state.gateway.stop).message == '机器狗未连接'


def test_timeout_sends_stop():
    app = create_app(config(cmd_deadline_s=.01, bridge_stale_s=10))
    with TestClient(app) as client:
        with client.websocket_connect('/ws/bridge') as ws:
            ws.send_json(HELLO)
            wait_online(client, True)
            pending = client.portal.start_task_soon(app.state.gateway.stand_up)
            cmd = next_command(ws)
            assert cmd['deadline_ms'] == 10
            assert pending.result(4).error == 'TIMEOUT'
            assert next_command(ws)['name'] == 'stop'
        wait_online(client, False)


def test_auth():
    with TestClient(create_app(config(bridge_token='secret'))) as client:
        with client.websocket_connect('/ws/bridge') as ws:
            ws.send_json({**HELLO, 'token': 'wrong'})
            assert ws.receive_json() == {'type': 'error', 'error': 'AUTH'}
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
        wait_online(client, False)


class Socket:
    def __init__(self):
        self.sent = []
        self.closed = False

    async def send_json(self, message):
        self.sent.append(message)

    async def close(self, **kwargs):
        self.closed = True


@pytest.mark.asyncio
async def test_replacement_stale_events_snapshot():
    robot = BridgeRobot(config(bridge_stale_s=.05))
    events = []
    robot.on_event(events.append)
    await robot.connect()
    first, second = Socket(), Socket()
    try:
        await robot.attach(first, 'mock')
        pending = asyncio.create_task(robot.stand_up())
        await asyncio.sleep(0)
        await robot.attach(second, 't1')
        assert first.closed and (await pending).error == 'ROBOT_OFFLINE'
        await robot.detach(first)
        assert (await robot.get_state()).online
        await robot.receive(second, {'type': 'state', 'battery': 73, 'action': 'test', 'action_status': 'RUNNING', 'busy': True})
        await robot.receive(second, {'type': 'asr', 'text': '你好', 'is_final': True, 'event_id': 'e1', 'confidence': .9})
        assert events[-1].type == 'asr' and events[-1].data['is_final']
        snapshot = asyncio.create_task(robot.snapshot())
        await asyncio.sleep(0)
        cmd = second.sent[-1]
        await robot.receive(second, {'type': 'result', 'id': cmd['id'], 'ok': True,
                                    'detail': {'jpeg_b64': base64.b64encode(b'jpeg').decode()}})
        assert await snapshot == b'jpeg'
        await asyncio.sleep(.09)
        assert not (await robot.get_state()).online
        assert (await robot.move(1)).error == 'ROBOT_OFFLINE'
        assert any(e.type == 'robot.connection' and not e.data['online'] for e in events)
        await robot.receive(second, {'type': 'pong'})
        assert (await robot.get_state()).online
    finally:
        await robot.close()


def test_hello_timeout_and_invalid_hello():
    with TestClient(create_app(config())) as client:
        with client.websocket_connect('/ws/bridge') as ws:
            with pytest.raises(WebSocketDisconnect) as caught:
                ws.receive_json()
            assert caught.value.code == 1008
        with client.websocket_connect('/ws/bridge') as ws:
            ws.send_json({'type': 'hello', 'robot': 'wrong'})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()


@pytest.mark.asyncio
async def test_offline_stop_log_and_invalid_snapshot():
    robot = BridgeRobot(config())
    events = []
    robot.on_event(events.append)
    assert (await robot.stop()).error == 'ROBOT_OFFLINE'
    assert events[-1].data == {'stage': 'error', 'text': '机器狗离线，无法下发停止，请用遥控器'}
    ws = Socket()
    await robot.attach(ws, 'mock')
    pending = asyncio.create_task(robot.snapshot())
    await asyncio.sleep(0)
    await robot.receive(ws, {'type': 'result', 'id': ws.sent[-1]['id'], 'ok': True,
                             'detail': {'jpeg_b64': '%%%'}})
    assert await pending is None
    await robot.close()
