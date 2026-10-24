from typing import Callable
from app.errors import ApiError, ROBOT_BUSY
from app.events import EventBus
from app.models import DemoMode
from app.services.commands import validate_command


class ModeService:
    def __init__(self, bus: EventBus, is_busy: Callable[[], bool] = lambda: False):
        self.bus = bus
        self.is_busy = is_busy
        self.mode = DemoMode.INDOOR
        self.navigation = None

    async def set_mode(self, mode: DemoMode) -> DemoMode:
        if self.navigation and self.navigation.status in {'ACTIVE', 'PAUSED'}:
            raise ApiError(ROBOT_BUSY, '导航进行中，请先取消导航', 409)
        if self.is_busy():
            raise ApiError(ROBOT_BUSY, '任务执行中，不能切换演示模式', 409)
        self.mode = DemoMode(mode)
        if self.navigation:
            await self.navigation.clear_route()
        await self.bus.publish('mode.changed', {'mode': self.mode.value})
        return self.mode
