import asyncio
import hmac
from contextlib import suppress

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.robot.bridge_client import BridgeRobot

router = APIRouter()


@router.websocket('/ws/bridge')
async def ws_bridge(ws: WebSocket):
    await ws.accept()
    state = ws.app.state
    gateway = state.gateway
    if not isinstance(gateway, BridgeRobot):
        await ws.close(code=1008)
        return
    attached = False
    try:
        hello = await asyncio.wait_for(ws.receive_json(), 5)
        if (not isinstance(hello, dict) or hello.get('type') != 'hello'
                or hello.get('robot') != 'T1' or hello.get('adapter') not in {'t1', 'mock'}
                or not all(isinstance(hello.get(key), str) for key in ('adapter_ver', 'sdk_commit'))):
            await ws.close(code=1008)
            return
        token = hello.get('token', '')
        if state.settings.bridge_token and (not isinstance(token, str) or not hmac.compare_digest(
                token.encode(), state.settings.bridge_token.encode())):
            await ws.send_json({'type': 'error', 'error': 'AUTH'})
            await ws.close(code=1008)
            return
        await gateway.attach(ws, hello['adapter'])
        attached = True
        await state.bus.log('info', f"桥接已连接 {hello['adapter']} {hello['adapter_ver']}")
        while True:
            await gateway.receive(ws, await ws.receive_json())
    except (asyncio.TimeoutError, ValueError):
        with suppress(Exception):
            await ws.close(code=1008)
    except WebSocketDisconnect:
        pass
    finally:
        if attached:
            await gateway.detach(ws)
