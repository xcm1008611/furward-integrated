import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import Route
from app.services.keywords import parse_fast_path, parse_keywords

DATA = Path(__file__).resolve().parents[1] / 'data'


@pytest.mark.parametrize('text', ['结束导航', '停止导航', '退出导航', '不走了', '不去了', '取消导航。', '帮我结束导航吧'])
def test_end_nav_phrases_use_fast_path(text):
    # 这些说法以前要么没听懂，要么被当成暂停，导致导航结束不了
    assert parse_fast_path(text).tool == 'nav_cancel'


def test_cancel_then_go_keeps_both_intents():
    assert parse_fast_path('不去了，带我去门口') is None
    intents = parse_keywords('不去了，带我去门口', ['门口'])
    assert [i.tool for i in intents] == ['nav_cancel', 'nav_go']


def test_pause_phrases_still_pause():
    assert parse_fast_path('停一下').tool == 'nav_pause'
    assert parse_fast_path('暂停导航').tool == 'nav_pause'


def wait_status(client, status, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = client.get('/api/nav/current').json()['data']
        if data['status'] == status:
            return data
        time.sleep(0.01)
    pytest.fail(f'等待 {status} 超时')


@pytest.mark.parametrize('phrase', ['结束导航', '不走了'])
def test_end_nav_by_voice_after_stop_button(settings, phrase):
    with TestClient(create_app(settings)) as client:
        assert client.post('/api/voice/text', json={'text': '带我去门口'}).json()['ok']
        wait_status(client, 'ACTIVE')
        # 手机页的“停止”只会暂停导航，之后必须还能结束
        assert client.post('/api/robot/stop').json()['ok']
        wait_status(client, 'PAUSED')
        reply = client.post('/api/voice/text', json={'text': phrase}).json()['data']
        assert reply['executed'][0]['tool'] == 'nav_cancel' and reply['executed'][0]['ok']
        assert wait_status(client, 'CANCELLED')['remaining_m'] == 0
        # 结束后可以切换模式，也能立刻去下一个地方
        assert client.post('/api/voice/text', json={'text': '带我去服务台'}).json()['ok']
        wait_status(client, 'ACTIVE')


def test_demo_city_endpoint_and_route_match(settings):
    city = json.loads((DATA / 'demo_city.json').read_text(encoding='utf-8'))
    route = Route.model_validate(json.loads((DATA / 'demo_routes' / 'city_demo.json').read_text(encoding='utf-8')))
    assert route.sample and route.cached and route.route_id == 'demo-city'
    assert len(route.polyline) == len(city['route']) == len(route.steps) + 1
    assert route.destination_name == city['destination_name']
    assert abs(sum(s.distance_m for s in route.steps) - route.distance_m) < 0.5
    with TestClient(create_app(settings)) as client:
        data = client.get('/api/demo/city').json()['data']
        assert data['buildings'] and data['route'] == city['route']


def test_demo_city_missing_returns_not_found(settings, tmp_path):
    settings.demo_city_path = str(tmp_path / 'none.json')
    with TestClient(create_app(settings)) as client:
        body = client.get('/api/demo/city').json()
        assert body['ok'] is False and body['error'] == 'NOT_FOUND'


def test_demo_route_needs_no_origin_or_amap(settings):
    # 没配默认起点、没配高德 Key，也能直接演示城市路线
    settings.outdoor_default_origin = ''
    with TestClient(create_app(settings)) as client:
        client.post('/api/mode', json={'mode': 'outdoor'})
        reply = client.post('/api/voice/text', json={'text': '带我去演示路线'}).json()['data']
        assert reply['executed'][0]['ok'], reply
        nav = client.get('/api/nav/current').json()['data']
        assert nav['route']['route_id'] == 'demo-city' and nav['status'] == 'IDLE'
        assert client.post('/api/nav/cancel').json()['data']['status'] == 'CANCELLED'
