#!/usr/bin/env python3
import argparse
import asyncio
import json
import logging
import math
import os
import signal
import time
from contextlib import suppress

import websockets
from websockets.exceptions import WebSocketException

try:
    from .adapters.base import result, command_id as current_command_id
    from .adapters.mock import MockAdapter
except ImportError:
    from adapters.base import result, command_id as current_command_id
    from adapters.mock import MockAdapter

logger = logging.getLogger(__name__)
RESERVED_SOURCES = {'rc', 'pnc', 'interaction', 'vr', 'app_proxy', 'coreon_fusion'}
MOTION = {'move', 'turn', 'stand_up', 'posture', 'mimic'}
COMMANDS = MOTION | {'stop', 'speak', 'led', 'snapshot'}


def validate_source(name):
    if not name.strip() or name in RESERVED_SOURCES:
        raise ValueError('输入源名称为空或与系统内置名称冲突')
    return name


class AuthenticationError(Exception):
    pass


class Bridge:
    def __init__(self, adapter, backend, token='', adapter_name='mock', heartbeat_timeout=3.0):
        self.adapter, self.backend, self.token = adapter, backend, token
        self.adapter_name, self.heartbeat_timeout = adapter_name, heartbeat_timeout
        self.motion_lock = asyncio.Lock()
        self.last_ping = 0
        self.tripped = False
        self.stopping = 0
        self.revision = 0
        self.tasks = set()

    async def _stop(self):
        self.revision += 1
        self.stopping += 1
        try:
            return await self.adapter.stop()
        finally:
            self.stopping -= 1

    async def session(self, ws):
        async def send(message):
            await ws.send(json.dumps(message, ensure_ascii=False))

        await send({'type': 'hello', 'robot': 'T1', 'adapter': self.adapter_name,
                    'adapter_ver': '0.6', 'sdk_commit': 'a460300013003b29b9ad291b1b857b0afe295b22', 'token': self.token})
        self.last_ping, self.tripped = time.monotonic(), False
        asr_queue = asyncio.Queue(maxsize=100)
        loop = asyncio.get_running_loop()

        def enqueue(data):
            if asr_queue.full():
                asr_queue.get_nowait()
            asr_queue.put_nowait(data)

        self.adapter.set_asr_handler(lambda data: loop.call_soon_threadsafe(enqueue, data))

        async def states():
            while True:
                state = await self.adapter.get_state()
                if state['ok']:
                    data = state['detail']
                    await send({'type': 'state', **data,
                                'busy': data.get('busy', False) or self.motion_lock.locked()})
                else:
                    await send({'type': 'error', **state})
                await asyncio.sleep(1)

        async def asr():
            while True:
                await send({**await asr_queue.get(), 'type': 'asr'})

        async def watchdog():
            while True:
                if time.monotonic() - self.last_ping > self.heartbeat_timeout and not self.tripped:
                    self.tripped = True
                    await self._stop()
                    logger.error('后端心跳超时，已停止机器狗')
                await asyncio.sleep(min(.1, self.heartbeat_timeout / 4))

        async def execute(message, revision):
            name, command_id = message.get('name'), message.get('id')
            context = current_command_id.set(command_id)
            locked = False
            try:
                args = message.get('args', {})
                deadline = message.get('deadline_ms', 20000) / 1000
                if name not in COMMANDS or not isinstance(args, dict) or not math.isfinite(deadline) or deadline <= 0:
                    raise ValueError()
                if name in MOTION:
                    if self.tripped or self.stopping or revision != self.revision:
                        outcome = result(False, error='CANCELLED', message='连接失联或已停止，请重新下发命令')
                        await send({'type': 'result', 'id': command_id, **outcome})
                        return
                    if self.motion_lock.locked():
                        await send({'type': 'result', 'id': command_id, **result(False, error='ROBOT_BUSY', message='机器狗正在执行动作')})
                        return
                    await self.motion_lock.acquire()
                    locked = True
                if name == 'stop':
                    outcome = await self._stop()
                else:
                    outcome = await asyncio.wait_for(getattr(self.adapter, name)(**args), deadline)
            except asyncio.TimeoutError:
                await self._stop()
                outcome = result(False, error='TIMEOUT', message='命令执行超时，已停止')
            except (ValueError, TypeError, KeyError):
                outcome = result(False, error='INVALID_ARGS', message='命令参数不合法')
            except Exception:
                logger.exception('命令执行失败')
                await self._stop()
                outcome = result(False, error='UPSTREAM_ERROR', message='机器人接口调用失败')
            finally:
                current_command_id.reset(context)
                if locked:
                    self.motion_lock.release()
            await send({'type': 'result', 'id': command_id, **outcome})

        async def receive():
            async for raw in ws:
                message = json.loads(raw)
                if not isinstance(message, dict):
                    continue
                if message.get('type') == 'error' and message.get('error') == 'AUTH':
                    raise AuthenticationError()
                if message.get('type') == 'ping':
                    self.last_ping, self.tripped = time.monotonic(), False
                    await send({'type': 'pong', 'ts': message.get('ts')})
                elif message.get('type') == 'cmd':
                    await send({'type': 'ack', 'id': message.get('id')})
                    task = asyncio.create_task(execute(message, self.revision))
                    self.tasks.add(task)
                    task.add_done_callback(self._finished)

        workers = [asyncio.create_task(fn()) for fn in (receive, states, asr, watchdog)]
        try:
            done, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            self.adapter.set_asr_handler(lambda data: None)
            # 先置零，再取消任务，防止取消清理延迟停止。
            try:
                await self._stop()
            finally:
                pending = workers + list(self.tasks)
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)

    def _finished(self, task):
        self.tasks.discard(task)
        if not task.cancelled():
            with suppress(Exception):
                task.result()

    async def run(self):
        delay = .25
        try:
            started = await self.adapter.start()
            if not started['ok']:
                raise RuntimeError(started['message'])
            while True:
                try:
                    async with websockets.connect(self.backend, max_size=16 * 1024 * 1024) as ws:
                        await self.session(ws)
                        delay = .25
                except AuthenticationError:
                    logger.error('token 错误，请检查 --token 与后端 BRIDGE_TOKEN')
                    delay = 10
                except (OSError, WebSocketException, ValueError):
                    logger.warning('桥接连接断开，将重连')
                await asyncio.sleep(delay)
                delay = min(5, delay * 2)
        finally:
            try:
                await self._stop()
            finally:
                closed = await self.adapter.close()
                if not closed['ok']:
                    logger.error('桥接资源释放失败：%s', closed['message'])


def parser():
    p = argparse.ArgumentParser(description='T1 机器狗桥接')
    p.add_argument('--backend', default=os.getenv('BACKEND_URL', 'ws://127.0.0.1:8000/ws/bridge'))
    p.add_argument('--token', default=os.getenv('BRIDGE_TOKEN', ''))
    p.add_argument('--adapter', choices=['mock', 't1'], default=os.getenv('BRIDGE_ADAPTER', 'mock'))
    p.add_argument('--sdk-path', default=os.getenv('T1_SDK_PATH', ''))
    p.add_argument('--mimic-operation', type=int, choices=[0, 2], default=0)
    p.add_argument('--camera-id', default=os.getenv('CAMERA_ID', 'head_stereo_left'))
    p.add_argument('--input-source-name', default=os.getenv('INPUT_SOURCE_NAME', 'moonstone_nav'))
    p.add_argument('--input-source-priority', type=int, default=int(os.getenv('INPUT_SOURCE_PRIORITY', '30')))
    p.add_argument('--heartbeat-timeout', type=float, default=float(os.getenv('HEARTBEAT_TIMEOUT', '3.0')))
    return p


def parse_args(argv=None):
    p = parser()
    args = p.parse_args(argv)
    try:
        validate_source(args.input_source_name)
        if not 20 <= args.input_source_priority <= 39:
            raise ValueError('输入源优先级必须在 SDK 建议的 20–39 范围内')
        if not math.isfinite(args.heartbeat_timeout) or args.heartbeat_timeout <= 0:
            raise ValueError('心跳超时必须是正数')
    except ValueError as exc:
        p.error(str(exc))
    return args


async def main(args):
    if args.adapter == 't1':
        try:
            from .adapters.t1 import T1Adapter
        except ImportError:
            from adapters.t1 import T1Adapter
        adapter = T1Adapter(args.sdk_path, args.camera_id, args.input_source_name, args.input_source_priority,
                            mimic_operation=args.mimic_operation)
    else:
        adapter = MockAdapter()
    bridge = Bridge(adapter, args.backend, args.token, args.adapter, args.heartbeat_timeout)
    task = asyncio.create_task(bridge.run())
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, task.cancel)
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    asyncio.run(main(parse_args()))
