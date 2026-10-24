from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict
from app.models import DemoMode

router = APIRouter()


class ModeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mode: DemoMode


@router.get('/api/mode')
async def get_mode(request: Request):
    return {'ok': True, 'data': {'mode': request.app.state.modes.mode}}


@router.post('/api/mode')
async def set_mode(body: ModeRequest, request: Request):
    mode = await request.app.state.modes.set_mode(body.mode)
    return {'ok': True, 'data': {'mode': mode}}
