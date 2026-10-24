import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.errors import ApiError
from app.models import DemoMode, NavPlanRequest
from app.services.keywords import parse_keywords
from test_assistant import assistant
from test_navigation import nav


@pytest.mark.parametrize('text', ['多少电', '电池', '电还够吗'])
def test_battery_words(text):
    assert parse_keywords(text, [])[0].tool == 'get_status'


@pytest.mark.asyncio
@pytest.mark.parametrize('text', ['你好', '嗨', '打个招呼', '前进1米', '左转90度'])
async def test_assistant_auto_stand(assistant, text):
    assistant.llm.available = False
    reply = await assistant.handle_text(text, 'text')
    assert reply.executed[0]['ok']
    assert [c.name for c in assistant.scheduler.current().steps][0] == 'stand_up'
    assert '完成' not in reply.text
    if text in ['你好', '嗨', '打个招呼']:
        assert reply.text == '你好！'


@pytest.mark.parametrize('name,args', [('move', {'distance_m': .1}), ('turn', {'angle_deg': 10}), ('mimic', {'motion': 'GREET'})])
def test_api_auto_stand(settings, name, args):
    with TestClient(create_app(settings)) as client:
        result = client.post('/api/robot/command', json={'name': name, 'args': args}).json()
        assert [c['name'] for c in result['data']['steps']] == ['stand_up', name]
        task = client.portal.call(client.app.state.scheduler.wait, result['data']['id'])
        assert task.status == 'DONE'
        again = client.post('/api/robot/command', json={'name': name, 'args': args}).json()
        assert [c['name'] for c in again['data']['steps']] == [name]


@pytest.mark.asyncio
async def test_missing_destinations(nav, monkeypatch):
    with pytest.raises(ApiError) as caught:
        await nav.plan(NavPlanRequest(mode='indoor', to='未知'))
    assert '没有找到"未知"，可以去：' in caught.value.message
    assert all(w in caught.value.message for w in ['服务台', '咖啡桌', '门口'])
    await nav.modes.set_mode(DemoMode.OUTDOOR)
    async def missing(_):
        raise ApiError('NOT_FOUND', '无结果')
    monkeypatch.setattr(nav.amap, 'search_place', missing)
    with pytest.raises(ApiError) as caught:
        await nav.plan(NavPlanRequest(mode='outdoor', origin=(121, 31), destination='未知'))
    assert '没有找到"未知"，可以去：' in caught.value.message
