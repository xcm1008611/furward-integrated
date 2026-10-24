import math

import httpx

from app.config import Settings
from app.errors import ApiError, NOT_FOUND, UPSTREAM_ERROR
from app.models import Route, RouteStep


def number(value, default=0.0):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else default
    except (TypeError, ValueError):
        return default


def location(value):
    try:
        lng, lat = map(float, value.split(','))
        if math.isfinite(lng) and math.isfinite(lat) and -180 <= lng <= 180 and -90 <= lat <= 90:
            return lng, lat
    except (AttributeError, TypeError, ValueError):
        pass
    return None


def mapping(value):
    return value if isinstance(value, dict) else {}


def items(value):
    return value if isinstance(value, list) else []


class AmapClient:
    def __init__(self, settings: Settings, transport=None):
        self.settings = settings
        self.client = httpx.AsyncClient(base_url=settings.amap_base_url, timeout=settings.amap_timeout_s, transport=transport)

    async def close(self):
        await self.client.aclose()

    async def _get(self, path, **params):
        if not self.settings.amap_key:
            raise ApiError(UPSTREAM_ERROR, '未配置高德 Key', 502)
        try:
            response = await self.client.get(path, params={**params, 'key': self.settings.amap_key}, timeout=self.settings.amap_timeout_s)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict) or str(data.get('status')) != '1':
                info = mapping(data).get('info') or '未知原因'
                raise ApiError(UPSTREAM_ERROR, f'高德服务失败：{info}', 502)
            return data
        except (httpx.HTTPError, ValueError) as exc:
            raise ApiError(UPSTREAM_ERROR, '高德服务请求失败', 502) from exc

    async def search_place(self, keywords) -> tuple[float, float, str]:
        data = await self._get('/v5/place/text', keywords=keywords, region=self.settings.outdoor_city)
        for poi in items(data.get('pois'))[:1]:
            point = location(mapping(poi).get('location'))
            if point:
                return *point, str(poi.get('name') or keywords)
        data = await self._get('/v3/geocode/geo', address=keywords, city=self.settings.outdoor_city)
        for geo in items(data.get('geocodes'))[:1]:
            point = location(mapping(geo).get('location'))
            if point:
                return *point, str(geo.get('formatted_address') or keywords)
        raise ApiError(NOT_FOUND, '找不到目的地', 404)

    async def walking(self, origin, destination) -> dict:
        data = await self._get('/v5/direction/walking', origin=','.join(map(str, origin)), destination=','.join(map(str, destination)), show_fields='cost,polyline,navi')
        paths = items(mapping(data.get('route')).get('paths'))
        if not paths:
            raise ApiError(UPSTREAM_ERROR, '高德未返回步行路线', 502)
        path = mapping(paths[0])
        distance = number(path.get('distance'))
        duration = number(mapping(path.get('cost')).get('duration'), distance / 1.2)
        polyline, steps = [], []
        for raw in items(path.get('steps')):
            raw = mapping(raw)
            points = [point for part in str(raw.get('polyline') or '').split(';') if (point := location(part))]
            for point in points:
                if not polyline or polyline[-1] != point:
                    polyline.append(point)
            instruction = str(raw.get('instruction') or '')
            # navi 缺失时退回指令文字；指令末尾描述的就是本段结束时的转向，如「…37米左转」。
            action = str(mapping(raw.get('navi')).get('action') or '') or instruction[-8:]
            action = 'turn_left' if '左' in action else 'turn_right' if '右' in action else 'straight' if '直' in action else 'other'
            steps.append(RouteStep(index=len(steps), instruction=instruction or '继续前行', distance_m=number(raw.get('step_distance')), action=action, end=points[-1] if points else destination))
        return Route(mode='outdoor', coord='gcj02', distance_m=distance, duration_s=duration, polyline=polyline or [origin, destination], steps=steps).model_dump(mode='json')
