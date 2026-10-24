from time import monotonic
from app import VERSION
from fastapi import APIRouter, Request

router = APIRouter()


@router.get('/api/health')
async def health(request: Request):
    state = request.app.state
    robot = await state.gateway.get_state()
    return {'ok': True, 'data': {'version': VERSION, 'lan_urls': state.lan_urls, 'robot_backend': state.settings.robot_backend, 'robot_online': robot.online, 'mode': state.modes.mode, 'uptime_s': monotonic() - state.started_at}}
