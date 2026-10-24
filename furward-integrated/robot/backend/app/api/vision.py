import asyncio
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.errors import ApiError, NOT_SUPPORTED, ROBOT_OFFLINE
from app.services.obstacle import MockSource

router = APIRouter()


def monitor_for(request):
    monitor = request.app.state.obstacle_monitor
    if monitor is None:
        raise ApiError(NOT_SUPPORTED, '相机与障碍物识别未启用')
    return monitor


@router.get('/api/vision/obstacle')
async def obstacle(request: Request):
    return {'ok': True, 'data': monitor_for(request).state()}


@router.get('/api/vision/snapshot.jpg')
async def snapshot(request: Request):
    jpeg = await monitor_for(request).annotated_jpeg()
    if jpeg is None:
        raise ApiError(ROBOT_OFFLINE, '暂时没有可用的相机画面', 503)
    return Response(jpeg, media_type='image/jpeg')


@router.get('/api/vision/stream')
async def stream(request: Request):
    monitor = monitor_for(request)

    async def frames():
        while not await request.is_disconnected():
            jpeg = await monitor.annotated_jpeg()
            if jpeg:
                yield b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(jpeg)).encode() + b'\r\n\r\n' + jpeg + b'\r\n'
            await asyncio.sleep(1/monitor.settings.stream_fps)

    return StreamingResponse(frames(), media_type='multipart/x-mixed-replace; boundary=frame')


class Injection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    level: Literal['stop', 'clear']
    label: str = Field('box', min_length=1, max_length=80)
    position: Literal['left', 'center', 'right'] = 'center'


@router.post('/api/debug/obstacle')
async def inject(body: Injection, request: Request):
    monitor = monitor_for(request)
    if not isinstance(monitor.source, MockSource):
        raise ApiError(NOT_SUPPORTED, '仅模拟相机支持注入障碍物')
    monitor.source.inject(body.level, body.label, body.position)
    return {'ok': True, 'data': {'accepted': True}}
