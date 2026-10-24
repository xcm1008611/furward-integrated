import json
import math

import httpx
import pytest

from app.config import Settings
from app.errors import ApiError
from app.services.amap import AmapClient
from app.services.coords import haversine_m, wgs84_to_gcj02
from app.services.indoor import IndoorMap


def test_coords():
    assert wgs84_to_gcj02(-74, 40) == (-74, 40)
    shanghai = (121.47, 31.23)
    assert 100 < haversine_m(shanghai, wgs84_to_gcj02(*shanghai)) < 1000
    assert haversine_m(shanghai, shanghai) == 0
    assert haversine_m((0, 0), (0, 1)) == pytest.approx(111195, abs=1)


@pytest.mark.asyncio
@pytest.mark.parametrize('cost,expected', [({'duration': '80'}, 80), (None, 100)])
async def test_amap_walking(cost, expected):
    def response(request):
        assert request.url.path == '/v5/direction/walking'
        assert request.url.params['show_fields'] == 'cost,polyline,navi'
        assert request.extensions['timeout']['read'] == 5
        path = {'distance': '120', 'steps': [
            {'instruction': '左转', 'step_distance': '30', 'polyline': '121,31;121.1,31.1', 'navi': {'action': '左转'}},
            {'instruction': '直行', 'step_distance': '90', 'polyline': '121.1,31.1;121.2,31.2', 'navi': {'action': '直行'}},
            {'navi': {'action': '右转'}}, {}]}
        if cost is not None:
            path['cost'] = cost
        return httpx.Response(200, json={'status': '1', 'route': {'paths': [path]}})
    client = AmapClient(Settings(_env_file=None, amap_key='test'), httpx.MockTransport(response))
    try:
        route = await client.walking((121, 31), (121.2, 31.2))
        assert route['duration_s'] == expected
        assert route['distance_m'] == 120
        assert len(route['polyline']) == 3
        assert [s['action'] for s in route['steps']] == ['turn_left', 'straight', 'turn_right', 'other']
        assert route['steps'][0]['end'] == [121.1, 31.1]
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['no_key', 'status', 'network', 'http', 'malformed', 'empty'])
async def test_amap_errors(case):
    def response(request):
        if case == 'no_key':
            pytest.fail('无 Key 不应发出请求')
        if case == 'network':
            raise httpx.ReadTimeout('模拟超时')
        if case == 'http':
            return httpx.Response(503)
        if case == 'malformed':
            return httpx.Response(200, text='invalid')
        return httpx.Response(200, json={'status': '1' if case == 'empty' else '0', 'info': '测试错误'})
    client = AmapClient(Settings(_env_file=None, amap_key='' if case == 'no_key' else 'test'), httpx.MockTransport(response))
    try:
        with pytest.raises(ApiError) as caught:
            await client.walking((121, 31), (122, 32))
        assert caught.value.code == 'UPSTREAM_ERROR'
        if case == 'no_key':
            assert caught.value.message == '未配置高德 Key'
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('fallback,missing', [(False, False), (True, False), (True, True)])
async def test_search_place(fallback, missing):
    paths = []
    def response(request):
        paths.append(request.url.path)
        assert request.url.params['key'] == 'test'
        if request.url.path == '/v5/place/text':
            assert request.url.params['region'] == '上海'
            data = {'pois': [] if fallback else [{'location': '121,31', 'name': '服务台'}]}
        else:
            assert request.url.params['city'] == '上海'
            data = {'geocodes': [] if missing else [{'location': '121,31'}]}
        return httpx.Response(200, json={'status': '1', **data})
    client = AmapClient(Settings(_env_file=None, amap_key='test'), httpx.MockTransport(response))
    try:
        if missing:
            with pytest.raises(ApiError) as caught:
                await client.search_place('服务台')
            assert caught.value.code == 'NOT_FOUND'
        else:
            assert await client.search_place('服务台') == (121, 31, '服务台')
        assert len(paths) == (2 if fallback else 1)
    finally:
        await client.close()


def test_indoor_alias_turn_and_split(settings):
    indoor = IndoorMap(settings)
    route = indoor.plan('出发点', '咖啡', 0)
    assert route.destination_name == '咖啡桌'
    assert [c.args['angle_deg'] for c in route.robot_plan if c.name == 'turn'] == [90]
    assert route.polyline[-1] == (2.5, 3.5)
    settings.max_move_m = 0.7
    route = indoor.plan('start', '前台', 0)
    assert len(route.robot_plan) == 3
    assert sum(c.args['distance_m'] for c in route.robot_plan) == pytest.approx(2)
    assert all(c.args['distance_m'] <= 0.7 for c in route.robot_plan)
    with pytest.raises(ApiError) as caught:
        indoor.find('不存在')
    assert caught.value.code == 'NOT_FOUND'
    indoor.data['edges'] = []
    with pytest.raises(ApiError) as caught:
        indoor.plan('start', 'door', 0)
    assert caught.value.code == 'NO_ROUTE'


@pytest.mark.parametrize('heading,target,expected', [(170, -170, 20), (-170, 170, -20), (0, 3, None)])
def test_indoor_angle_wrap(settings, heading, target, expected):
    indoor = IndoorMap(settings)
    indoor.waypoints['desk'].update(x=0.5+math.cos(math.radians(target)), y=0.5+math.sin(math.radians(target)))
    route = indoor.plan('start', 'desk', heading)
    turns = [c.args['angle_deg'] for c in route.robot_plan if c.name == 'turn']
    assert turns == ([] if expected is None else pytest.approx([expected]))


@pytest.mark.asyncio
async def test_walking_action_falls_back_to_instruction_text():
    # 真实高德响应可能不带 navi，此时从指令末尾推断转向。
    payload = {'status': '1', 'route': {'paths': [{'distance': '100', 'steps': [
        {'instruction': '沿卓闻路向西北步行37米左转', 'step_distance': '37', 'polyline': '121.1,31.1;121.2,31.2'},
        {'instruction': '沿海科路步行472米向右前方行走', 'step_distance': '472', 'polyline': '121.2,31.2;121.3,31.3'},
        {'instruction': '向西步行22米到达终点', 'step_distance': '22', 'polyline': '121.3,31.3;121.4,31.4'},
    ]}]}}
    client = AmapClient(Settings(amap_key='k'), transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)))
    try:
        route = await client.walking((121.0, 31.0), (121.4, 31.4))
    finally:
        await client.close()
    assert [step['action'] for step in route['steps']] == ['turn_left', 'turn_right', 'other']
