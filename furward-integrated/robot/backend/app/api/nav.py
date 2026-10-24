from typing import Literal
from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict
from app.models import NavPlanRequest

router = APIRouter()


class PauseRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reason: Literal['user', 'obstacle'] = 'user'


class LocationRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    lng: float
    lat: float
    coord: Literal['wgs84', 'gcj02'] = 'gcj02'


@router.post('/api/nav/plan')
async def plan(body: NavPlanRequest, request: Request):
    return {'ok': True, 'data': await request.app.state.navigation.plan(body)}


@router.get('/api/nav/current')
async def current(request: Request):
    return {'ok': True, 'data': request.app.state.navigation.current()}


@router.post('/api/nav/pause')
async def pause(request: Request, body: PauseRequest | None = None):
    return {'ok': True, 'data': await request.app.state.navigation.pause(body.reason if body else 'user')}


@router.post('/api/nav/location')
async def update_location(body: LocationRequest, request: Request):
    return {'ok': True, 'data': await request.app.state.navigation.update_location(body.lng, body.lat, body.coord)}


def action_endpoint(action):
    async def endpoint(request: Request):
        return {'ok': True, 'data': await getattr(request.app.state.navigation, action)()}
    endpoint.__name__ = 'nav_' + action
    return endpoint


for action in ('next', 'repeat', 'execute', 'resume', 'cancel'):
    router.add_api_route('/api/nav/' + action, action_endpoint(action), methods=['POST'])


@router.get('/api/indoor/map')
async def indoor_map(request: Request):
    return {'ok': True, 'data': request.app.state.indoor_map.data}
