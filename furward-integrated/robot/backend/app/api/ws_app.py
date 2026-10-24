import asyncio
from contextlib import suppress
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


@router.websocket('/ws/app')
async def ws_app(websocket: WebSocket):
    await websocket.accept()
    state = websocket.app.state
    bus = state.bus
    queue = bus.subscribe()
    workers = []
    try:
        robot = await state.state_publisher.get_state()
        # 握手和心跳只投递给当前连接，仍统一经过事件总线。
        await bus.publish('hello', {'mode': state.modes.mode.value, 'robot': robot.model_dump(mode='json')}, target=queue)

        async def send():
            while True:
                await websocket.send_json(await queue.get())

        async def receive():
            while True:
                try:
                    message = await websocket.receive_json()
                except ValueError:
                    continue
                if isinstance(message, dict) and message.get('type') == 'ping':
                    await bus.publish('pong', {}, target=queue)

        workers = [asyncio.create_task(send()), asyncio.create_task(receive())]
        done, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
        for worker in done:
            worker.result()
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        bus.unsubscribe(queue)
        for worker in workers:
            worker.cancel()
        with suppress(asyncio.CancelledError):
            await asyncio.gather(*workers, return_exceptions=True)
