import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse

from app import VERSION
from app.errors import ApiError, NOT_FOUND
from app.services.indoor import data_path

router = APIRouter()
STATIC_DIR = Path(__file__).resolve().parents[1] / 'static'
MEDIA_DIR = STATIC_DIR / 'media'
MEDIA_TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
               '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm'}


@router.get('/api/config/public')
async def public_config(request: Request):
    state = request.app.state
    return {'ok': True, 'data': {
        'version': VERSION, 'mode': state.modes.mode,
        'amap_js_key': state.settings.amap_js_key,
        'amap_security_code': state.settings.amap_security_code,
        'has_llm': state.llm.available, 'obstacle_source': state.settings.obstacle_source,
        'indoor_waypoints': [{'id': key, 'name': waypoint['name']}
                             for key, waypoint in state.indoor_map.waypoints.items()],
    }}


@router.get('/api/demo/city')
async def demo_city(request: Request):
    # 室外演示路线的离线城市底图，文件较小，直接整份返回
    path = data_path(request.app.state.settings.demo_city_path)
    try:
        data = json.loads(await asyncio.to_thread(path.read_text, encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ApiError(NOT_FOUND, '演示城市地图不存在', 404) from exc
    return {'ok': True, 'data': data}


@router.get('/debug', include_in_schema=False)
async def debug():
    return FileResponse(STATIC_DIR / 'debug.html', media_type='text/html')


@router.get('/', include_in_schema=False)
async def assist_page():
    # 视障用户的手机交互页，扫码直达
    return FileResponse(STATIC_DIR / 'assist.html', media_type='text/html')


@router.get('/showcase', include_in_schema=False)
async def showcase_page():
    return FileResponse(STATIC_DIR / 'showcase.html', media_type='text/html')


@router.api_route('/media/{name}', methods=['GET', 'HEAD'], include_in_schema=False)
async def media(name: str):
    # 只允许读取 media 目录下的直接文件，防止 ../ 越界。
    path = (MEDIA_DIR / name).resolve()
    if path.parent != MEDIA_DIR.resolve() or not path.is_file() or path.suffix.lower() not in MEDIA_TYPES:
        raise ApiError(NOT_FOUND, '媒体文件不存在', 404)
    return FileResponse(path, media_type=MEDIA_TYPES[path.suffix.lower()])
