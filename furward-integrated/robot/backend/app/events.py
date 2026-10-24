import asyncio
from copy import deepcopy
from time import time


class EventBus:
    def __init__(self, queue_size: int = 128):
        self.queue_size = queue_size
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=self.queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        self._subscribers.discard(queue)

    async def publish(self, type: str, data: dict | None, *, target: asyncio.Queue | None = None):
        event = {'type': type, 'data': deepcopy(data), 'ts': time()}
        for queue in (tuple(self._subscribers) if target is None else (target,)):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(deepcopy(event))

    async def log(self, stage: str, text: str, **extra):
        if stage not in {'heard', 'understood', 'executed', 'error', 'info'}:
            raise ValueError('日志阶段不合法')
        await self.publish('log', {**extra, 'stage': stage, 'text': text})
