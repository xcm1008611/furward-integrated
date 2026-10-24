"""生成现场离线路线；在 backend 目录运行。"""
import argparse
import asyncio
import json
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings
from app.errors import ApiError
from app.models import Route
from app.services.amap import AmapClient, location
from app.services.indoor import data_path


async def cache(args):
    settings = Settings()
    origin = location(args.origin)
    if origin is None:
        raise ApiError('INVALID_ARGS', '起点格式应为 GCJ-02 经度,纬度')
    client = AmapClient(settings)
    try:
        destination = location(args.destination)
        if destination is None:
            lng, lat, _ = await client.search_place(args.destination)
            destination = lng, lat
        route = Route.model_validate(await client.walking(origin, destination))
        route.destination_name = args.name
        route.aliases = list(dict.fromkeys([args.destination, *args.alias]))
        route.cached = True
        directory = data_path(settings.demo_routes_dir)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f'route-{uuid4().hex}.json'
        path.write_text(json.dumps(route.model_dump(mode='json'), ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'路线已保存：{path}')
    finally:
        await client.close()


def main():
    parser = argparse.ArgumentParser(description='生成高德真实步行路线离线缓存')
    parser.add_argument('--origin', required=True, help='GCJ-02 起点，经度,纬度')
    parser.add_argument('--destination', required=True, help='目的地名称或 GCJ-02 经度,纬度')
    parser.add_argument('--name', required=True, help='缓存目的地名称')
    parser.add_argument('--alias', action='append', default=[], help='额外匹配别名，可重复指定')
    args = parser.parse_args()
    try:
        asyncio.run(cache(args))
    except ApiError as exc:
        parser.exit(1, f'{exc.code}：{exc.message}\n')


if __name__ == '__main__':
    main()
