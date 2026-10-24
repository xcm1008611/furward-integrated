import asyncio
import pytest
from app.models import RobotEvent
from app.robot import create_gateway
from app.robot.mock import LOCOMOTION, MockRobot


@pytest.mark.asyncio
async def test_state_machine(settings):
    robot = MockRobot(settings)
    events: list[RobotEvent] = []
    robot.on_event(events.append)
    await robot.connect()
    assert (await robot.get_state()).action == 'PASSIVE_DEFAULT'
    for result in (await robot.move(1), await robot.turn(90), await robot.mimic('GREET')):
        assert result.error == 'NOT_READY'
    assert (await robot.stand_up()).ok
    assert any(e.data['action'] == 'QUADRUPED_STAND_DEFAULT' and e.data['action_status'] == 'TRANSITION' for e in events)
    assert (await robot.get_state()).action == LOCOMOTION
    for name, action in [('sit', 'QUADRUPED_SIT_DOWN_DEFAULT'), ('lie_down', 'QUADRUPED_GET_DOWN_DEFAULT'), ('stand', LOCOMOTION)]:
        assert (await robot.posture(name)).ok
        assert (await robot.get_state()).action == action
    assert (await robot.mimic('GREET')).ok
    assert (await robot.get_state()).action_status == 'RUNNING'
    assert (await robot.snapshot()).startswith(b'\xff\xd8')


@pytest.mark.asyncio
@pytest.mark.parametrize('name,args', [('move', (3,)), ('turn', (180,))])
async def test_stop_progress_and_busy(settings, name, args):
    robot = MockRobot(settings)
    await robot.stand_up()
    running = asyncio.create_task(getattr(robot, name)(*args))
    await asyncio.sleep(0.005)
    assert (await robot.move(1)).error == 'ROBOT_BUSY'
    stop = await robot.stop()
    result = await running
    assert stop.ok and result.error == 'CANCELLED'
    assert 0 < result.detail['completed_ratio'] < 1
    assert result.detail == stop.detail
    state = await robot.get_state()
    assert state.action == LOCOMOTION and not state.busy
    assert state.battery == 89


@pytest.mark.asyncio
async def test_failure_injection(settings):
    settings.mock_fail = 'move, speak'
    robot = MockRobot(settings)
    assert (await robot.move(1)).error == 'MOCK_FAIL'
    assert (await robot.speak('你好')).error == 'MOCK_FAIL'


def test_bridge_factory(settings):
    from app.robot.bridge_client import BridgeRobot
    settings.robot_backend = 'bridge'
    assert isinstance(create_gateway(settings), BridgeRobot)
