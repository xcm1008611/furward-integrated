import pytest
import pytest_asyncio
from app.config import Settings
from app.events import EventBus
from app.robot.mock import MockRobot
from app.services.modes import ModeService
from app.services.scheduler import Scheduler


@pytest.fixture
def settings():
    return Settings(_env_file=None, mock_time_scale=0.01)


@pytest_asyncio.fixture
async def components(settings):
    bus = EventBus()
    robot = MockRobot(settings)
    await robot.connect()
    modes = ModeService(bus)
    scheduler = Scheduler(robot, modes, settings, bus)
    return robot, modes, scheduler, bus


@pytest.fixture(autouse=True)
def local_lan_discovery(monkeypatch):
    # 测试不读取开发机网卡、不探测路由。
    monkeypatch.setattr('app.main.lan_urls', lambda port, lan_host='': [f'http://{lan_host or "192.168.10.2"}:{port}/debug'])
