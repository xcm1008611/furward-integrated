import asyncio
from contextlib import asynccontextmanager
from time import monotonic

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import VERSION
from app.lan import lan_urls
from app.api import public, health, mode, robot, tasks, ws_app, nav, voice, vision, ws_bridge
from app.config import Settings, get_settings
from app.errors import install_handlers
from app.events import EventBus
from app.robot import create_gateway
from app.services.amap import AmapClient
from app.services.detector import create_detector
from app.services.obstacle import ObstacleMonitor, MockSource, RtspSource, VideoFileSource
from app.services.assistant import Assistant
from app.services.llm import LLMClient
from app.services.indoor import IndoorMap
from app.services.navigation import NavigationService
from app.services.modes import ModeService
from app.services.scheduler import Scheduler, StatePublisher


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        factory = app.dependency_overrides.get(get_settings, get_settings)
        config = settings if settings is not None else factory()
        state = app.state
        state.settings = config
        state.lan_urls = await asyncio.to_thread(lan_urls, config.port, config.lan_host)
        state.started_at = monotonic()
        state.bus = EventBus(config.event_queue_size)
        state.gateway = create_gateway(config)
        state.modes = ModeService(state.bus)
        state.scheduler = Scheduler(state.gateway, state.modes, config, state.bus)
        state.indoor_map = await asyncio.to_thread(IndoorMap, config)
        state.amap = AmapClient(config)
        state.navigation = NavigationService(config, state.scheduler, state.modes, state.bus, state.indoor_map, state.amap)
        state.state_publisher = StatePublisher(state.gateway, state.scheduler, state.bus, config.state_interval_s)

        state.obstacle_monitor = None
        if config.obstacle_source != 'none':
            source = {'mock': MockSource, 'video': VideoFileSource, 'rtsp': RtspSource}[config.obstacle_source](config)
            detector = await asyncio.to_thread(create_detector, config)
            state.obstacle_monitor = ObstacleMonitor(config, source, detector, state.navigation,
                                                     state.gateway, state.modes, state.bus)
            state.obstacle_hints = state.obstacle_monitor.hints_text
        state.llm = LLMClient(config)
        if not hasattr(state, 'obstacle_hints'):
            state.obstacle_hints = None
        state.assistant = Assistant(config, state.gateway, state.scheduler, state.modes,
                                    state.navigation, state.bus, state.llm,
                                    lambda: state.obstacle_hints() if state.obstacle_hints else '',
                                    state.obstacle_monitor.latest_jpeg if state.obstacle_monitor else None)

        async def forward(event):
            if event.type == 'asr' and event.data.get('is_final') is True:
                state.assistant.background(state.assistant.handle_text(
                    event.data.get('text', ''), 'robot', event.data.get('event_id')))
            data = event.data
            if event.type == 'robot.state':
                data = (await state.state_publisher.get_state()).model_dump(mode='json')
            await state.bus.publish(event.type, data)

        state.gateway.on_event(forward)
        await state.gateway.connect()
        state.state_publisher.start()
        if state.obstacle_monitor:
            state.obstacle_monitor.start()
        try:
            yield
        finally:
            if state.obstacle_monitor:
                await state.obstacle_monitor.close()
            await state.assistant.close()
            await state.llm.close()
            await state.navigation.close()
            await state.amap.close()
            await state.state_publisher.close()
            await state.scheduler.close()
            if config.robot_backend == 'bridge':
                await state.gateway.close()

    app = FastAPI(title='导盲机器狗后端', version=VERSION, lifespan=lifespan)
    install_handlers(app)
    app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])
    for router in (public.router, health.router, mode.router, robot.router, tasks.router, ws_app.router, nav.router, voice.router, vision.router, ws_bridge.router):
        app.include_router(router)
    return app


app = create_app()


if __name__ == '__main__':
    import uvicorn
    config = get_settings()
    uvicorn.run('app.main:app', host=config.host, port=config.port)
