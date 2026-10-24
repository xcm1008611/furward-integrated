import pytest
from app.events import EventBus


@pytest.mark.asyncio
async def test_independent_bounded_subscriptions():
    bus = EventBus(queue_size=2)
    slow, fast = bus.subscribe(), bus.subscribe()
    for i in range(4):
        await bus.publish('sample', {'i': i})
        assert (await fast.get())['data']['i'] == i
    assert slow.qsize() == 2
    assert (await slow.get())['data']['i'] == 2
    assert (await slow.get())['data']['i'] == 3
    await bus.publish('hello', {}, target=fast)
    assert slow.empty()
    assert (await fast.get())['type'] == 'hello'
    await bus.log('info', '测试日志', source='test')
    assert (await fast.get())['data']['text'] == '测试日志'
    bus.unsubscribe(slow)
    bus.unsubscribe(fast)
    assert not bus._subscribers
