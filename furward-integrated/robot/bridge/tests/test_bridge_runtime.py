import asyncio
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import Bridge, parse_args, RESERVED_SOURCES
from adapters.mock import MockAdapter
from adapters.t1 import valid_velocity, completed_ratio


async def recv(ws, kind, command_id=None):
    while True:
        message = json.loads(await asyncio.wait_for(ws.recv(), 2))
        if message['type'] == kind and (command_id is None or message.get('id') == command_id):
            return message


async def send(ws, name, command_id, args=None, deadline=2000):
    await ws.send(json.dumps({'type': 'cmd', 'id': command_id, 'name': name, 'args': args or {}, 'deadline_ms': deadline}))


@pytest.mark.asyncio
async def test_local_server_roundtrip_stop_busy_and_timeout():
    complete = asyncio.get_running_loop().create_future()
    adapter = MockAdapter()

    async def backend(ws):
        try:
            hello = await recv(ws, 'hello')
            assert hello['adapter'] == 'mock' and hello['robot'] == 'T1'
            await ws.send(json.dumps({'type': 'ping', 'ts': 123}))
            assert (await recv(ws, 'pong'))['ts'] == 123
            await send(ws, 'move', 'm', {'distance_m': 1, 'speed_mps': .3, 'duration_s': 10}, 15000)
            assert (await recv(ws, 'ack'))['id'] == 'm'
            await asyncio.sleep(.02)
            await send(ws, 'turn', 'busy', {'angle_deg': 90, 'angular_speed': .5, 'duration_s': 3})
            assert (await recv(ws, 'result', 'busy'))['error'] == 'ROBOT_BUSY'
            await send(ws, 'stop', 's')
            results = {}
            while len(results) < 2:
                message = await recv(ws, 'result')
                results[message['id']] = message
            assert results['s']['ok']
            assert results['m']['error'] == 'CANCELLED'
            assert 0 < results['m']['detail']['completed_ratio'] < 1
            await send(ws, 'move', 'timeout', {'distance_m': 1, 'speed_mps': .3, 'duration_s': 10}, 20)
            assert (await recv(ws, 'result', 'timeout'))['error'] == 'TIMEOUT'
            adapter.asr_handler({'text': '你好', 'event_id': 'e', 'confidence': 1, 'is_final': True})
            assert (await recv(ws, 'asr'))['event_id'] == 'e'
            complete.set_result(True)
        except BaseException as exc:
            if not complete.done():
                complete.set_exception(exc)

    async with websockets.serve(backend, '127.0.0.1', 0) as server:
        port = server.sockets[0].getsockname()[1]
        bridge = Bridge(adapter, f'ws://127.0.0.1:{port}', heartbeat_timeout=5)
        task = asyncio.create_task(bridge.run())
        try:
            assert await asyncio.wait_for(complete, 5)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_watchdog_once_rearms_disconnect():
    adapter = MockAdapter()
    adapter.stop = AsyncMock(wraps=adapter.stop)
    finished = asyncio.Event()
    complete = asyncio.get_running_loop().create_future()

    async def backend(ws):
        try:
            await recv(ws, 'hello')
            await asyncio.sleep(.14)
            assert adapter.stop.call_count == 1
            await asyncio.sleep(.1)
            assert adapter.stop.call_count == 1
            await ws.send(json.dumps({'type': 'ping'}))
            await recv(ws, 'pong')
            await asyncio.sleep(.14)
            assert adapter.stop.call_count == 2
            complete.set_result(True)
            await finished.wait()
        except BaseException as exc:
            if not complete.done():
                complete.set_exception(exc)

    async with websockets.serve(backend, '127.0.0.1', 0) as server:
        port = server.sockets[0].getsockname()[1]
        bridge = Bridge(adapter, f'ws://127.0.0.1:{port}', heartbeat_timeout=.05)
        task = asyncio.create_task(bridge.run())
        try:
            assert await asyncio.wait_for(complete, 3)
        finally:
            finished.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        assert adapter.stop.call_count >= 3


@pytest.mark.parametrize('name', sorted(RESERVED_SOURCES))
def test_reserved_sources(name):
    with pytest.raises(SystemExit):
        parse_args(['--input-source-name', name])


@pytest.mark.parametrize('value,valid', [(0, True), (.2, True), (-.2, True), (.3, True), (.199, False), (-.1, False), (float('nan'), False), (float('inf'), False), (True, False)])
def test_velocity(value, valid):
    assert valid_velocity(value) is valid


@pytest.mark.parametrize('elapsed,duration,expected', [(1, 4, .25), (-1, 4, 0), (8, 4, 1), (0, 0, 1)])
def test_progress(elapsed, duration, expected):
    assert completed_ratio(elapsed, duration) == expected


def test_import_without_ros():
    root = Path(__file__).resolve().parents[1]
    script = "import sys; import adapters.t1; assert 'rclpy' not in sys.modules; assert 'aimdk_msgs' not in sys.modules"
    subprocess.run([sys.executable, '-c', script], cwd=root, check=True)


@pytest.mark.asyncio
async def test_disconnect_stops_active_motion_and_closes():
    adapter = MockAdapter()
    adapter.stop = AsyncMock(wraps=adapter.stop)
    adapter.close = AsyncMock(wraps=adapter.close)
    complete = asyncio.get_running_loop().create_future()

    async def backend(ws):
        try:
            await recv(ws, 'hello')
            await send(ws, 'move', 'm', {'distance_m': 1, 'speed_mps': .3, 'duration_s': 10}, 15000)
            await recv(ws, 'ack')
            await asyncio.sleep(.02)
            assert adapter.state['busy']
            await ws.close()
            for _ in range(50):
                if adapter.stop.call_count and not adapter.state['busy']:
                    complete.set_result(True)
                    return
                await asyncio.sleep(.005)
            raise AssertionError('断线后运动未停止')
        except BaseException as exc:
            if not complete.done():
                complete.set_exception(exc)

    async with websockets.serve(backend, '127.0.0.1', 0) as server:
        port = server.sockets[0].getsockname()[1]
        task = asyncio.create_task(Bridge(adapter, f'ws://127.0.0.1:{port}').run())
        try:
            assert await asyncio.wait_for(complete, 3)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        assert adapter.close.call_count == 1


@pytest.mark.asyncio
async def test_auth_error_logs_and_waits_ten_seconds(monkeypatch, caplog):
    import bridge as runtime

    class Socket:
        async def send(self, raw):
            pass

        def __aiter__(self):
            return self

        async def __anext__(self):
            return json.dumps({'type': 'error', 'error': 'AUTH'})

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    adapter = MockAdapter()
    adapter.stop = AsyncMock(wraps=adapter.stop)
    adapter.close = AsyncMock(wraps=adapter.close)
    worker = Bridge(adapter, 'ws://unused', token='wrong')
    delays = []
    original_sleep = asyncio.sleep
    run_task = asyncio.current_task()

    async def sleep(delay):
        if asyncio.current_task() is run_task:
            delays.append(delay)
            if len(delays) == 2:
                raise asyncio.CancelledError()
            return
        await original_sleep(0)

    monkeypatch.setattr(runtime.websockets, 'connect', lambda *a, **kw: Socket())
    monkeypatch.setattr(runtime.asyncio, 'sleep', sleep)
    with pytest.raises(asyncio.CancelledError):
        await worker.run()
    assert delays == [10, 10]
    assert caplog.text.count('token 错误，请检查 --token 与后端 BRIDGE_TOKEN') == 2
    assert adapter.stop.await_count >= 2
    adapter.close.assert_awaited_once()


@pytest.mark.parametrize('operation', [0, 2])
@pytest.mark.asyncio
async def test_mimic_operation_request(operation):
    from types import SimpleNamespace as NS
    from adapters.t1 import T1Adapter, LOCOMOTION

    class Request:
        MIMIC_QY = 1

        def __init__(self):
            self.header = NS()

    adapter = T1Adapter(mimic_operation=operation)
    adapter.types = {'SetMcMotion': NS(Request=Request)}
    adapter._stamp = lambda: 123
    adapter.stand_up = AsyncMock(return_value={'ok': True})
    adapter.common_state = NS(SUCCESS=1, RUNNING=2)
    adapter._call = AsyncMock(return_value=NS(response=NS(
        header=NS(code=0), state=NS(value=1, reason=''), task_id='t')))
    adapter._action = AsyncMock(side_effect=[('MIMIC', 0), (LOCOMOTION, 100)])
    assert (await adapter.mimic('GREET'))['ok']
    name, request = adapter._call.call_args.args
    assert name == 'SetMcMotion' and request.motion == 'QUAD_MIMIC_GREET'
    if operation:
        assert request.operation == 2
    else:
        assert not hasattr(request, 'operation')
    assert parse_args(['--mimic-operation', str(operation)]).mimic_operation == operation


def test_mimic_operation_default_and_invalid():
    from adapters.t1 import T1Adapter

    assert parse_args([]).mimic_operation == T1Adapter().mimic_operation == 0
    for value in (-1, 1, 3):
        with pytest.raises(SystemExit):
            parse_args(['--mimic-operation', str(value)])
        with pytest.raises(ValueError):
            T1Adapter(mimic_operation=value)
