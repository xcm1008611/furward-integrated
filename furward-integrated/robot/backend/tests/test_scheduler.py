import asyncio
import pytest
from app.errors import ApiError
from app.models import Command, DemoMode, TaskStatus


async def finish(scheduler):
    for _ in range(200):
        if not scheduler.busy:
            return scheduler.current()
        await asyncio.sleep(0.005)
    pytest.fail('任务未及时结束')


@pytest.mark.asyncio
async def test_sequence_and_listener(components):
    robot, modes, scheduler, bus = components
    queue = bus.subscribe()
    ended = []
    scheduler.add_listener(ended.append)
    task = await scheduler.submit('演示', [Command(name='stand_up'), Command(name='move', args={'distance_m': 1}), Command(name='turn', args={'angle_deg': -90})], 'nav')
    assert task.status == TaskStatus.QUEUED
    final = await finish(scheduler)
    assert final.status == TaskStatus.DONE and final.current_step == 2
    assert final.step_started_at is not None and final.source == 'nav'
    assert len(ended) == 1
    updates = []
    while not queue.empty():
        event = queue.get_nowait()
        if event['type'] == 'task.update':
            updates.append(event['data'])
    assert [x['current_step'] for x in updates if x['status'] == 'RUNNING'] == [0, 1, 2]
    assert updates[0]['status'] == 'QUEUED'
    await scheduler.close()


@pytest.mark.asyncio
async def test_busy_and_stop(components):
    robot, modes, scheduler, bus = components
    await robot.stand_up()
    await scheduler.submit('移动', [Command(name='move', args={'distance_m': 3})])
    with pytest.raises(ApiError, match='已有任务') as exc:
        await scheduler.submit('重复', [Command(name='stand_up')])
    assert exc.value.code == 'ROBOT_BUSY'
    with pytest.raises(ApiError) as exc:
        await modes.set_mode(DemoMode.OUTDOOR)
    assert exc.value.code == 'ROBOT_BUSY'
    await asyncio.sleep(0.005)
    result = await scheduler.stop()
    assert result['task'].status == TaskStatus.CANCELLED
    assert 0 < result['completed_ratio'] < 1
    assert not scheduler.busy
    assert (await robot.get_state()).busy is False
    assert (await scheduler.stop())['task'] is None
    await modes.set_mode(DemoMode.OUTDOOR)


@pytest.mark.asyncio
async def test_failure_skips_rest(components):
    robot, modes, scheduler, bus = components
    await scheduler.submit('失败', [Command(name='move', args={'distance_m': 1}), Command(name='stand_up')])
    task = await finish(scheduler)
    assert task.status == TaskStatus.FAILED and task.error == 'NOT_READY'
    assert task.current_step == 0
    assert (await robot.get_state()).action == 'PASSIVE_DEFAULT'


@pytest.mark.asyncio
async def test_stop_before_worker_starts(components):
    robot, modes, scheduler, bus = components
    ended = []
    scheduler.add_listener(ended.append)
    await scheduler.submit('站起', [Command(name='stand_up')])
    await scheduler.stop()
    assert scheduler.current().status == TaskStatus.CANCELLED
    assert len(ended) == 1
    assert (await robot.get_state()).action == 'PASSIVE_DEFAULT'


@pytest.mark.asyncio
async def test_stop_command_bypasses_busy(components):
    robot, modes, scheduler, bus = components
    await scheduler.submit('播报', [Command(name='speak', args={'text': '字' * 100})])
    await asyncio.sleep(0.005)
    task = await scheduler.submit('停止', [Command(name='stop')])
    assert task.status == TaskStatus.DONE
    assert scheduler.current().status == TaskStatus.CANCELLED
    assert not scheduler.busy


@pytest.mark.asyncio
async def test_timeout(components, monkeypatch):
    robot, modes, scheduler, bus = components
    scheduler.settings.cmd_deadline_s = 0.01
    calls = []

    async def hang(mode):
        await asyncio.sleep(10)

    original_stop = robot.stop

    async def stop():
        calls.append('stop')
        return await original_stop()

    monkeypatch.setattr(robot, 'led', hang)
    monkeypatch.setattr(robot, 'stop', stop)
    await scheduler.submit('超时', [Command(name='led', args={'mode': 'RAINBOW'}), Command(name='stand_up')])
    task = await finish(scheduler)
    assert task.status == TaskStatus.FAILED and task.error == 'TIMEOUT'
    assert calls == ['stop'] and task.current_step == 0


@pytest.mark.asyncio
async def test_all_steps_validated_before_start(components):
    robot, modes, scheduler, bus = components
    with pytest.raises(ApiError):
        await scheduler.submit('非法序列', [Command(name='stand_up'), Command(name='move', args={'distance_m': 4})])
    assert scheduler.current() is None and not scheduler.busy
