import asyncio
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock

import cv2
import numpy as np
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import Command, DemoMode, RobotEvent
from app.services.assistant import Assistant, TOOLS
from app.services.keywords import parse_fast_path, parse_keywords
from app.services.llm import LLMClient, LLMError, LLMResult, ToolCall
from test_navigation import nav, until, plan_indoor


class FakeLLM:
    available = True

    def __init__(self, result=None, error=None):
        self.result = result or LLMResult()
        self.error = error
        self.calls = []
        self.images = []

    async def chat_tools(self, messages, tools):
        self.calls.append((messages, tools))
        if self.error:
            raise self.error
        return self.result

    async def describe_image(self, jpeg, hints):
        self.images.append((jpeg, hints))
        return '正前方有色块'


@pytest_asyncio.fixture
async def assistant(nav):
    llm = FakeLLM()
    result = Assistant(nav.settings, nav.scheduler.gateway, nav.scheduler, nav.modes, nav, nav.bus, llm)
    yield result
    await result.close()


@pytest.mark.parametrize('text,tool', [('停一下', 'nav_pause'), ('停', 'robot_stop'), ('停下吧！', 'robot_stop'),
    ('STOP', 'robot_stop'), ('等一下', 'nav_pause'), ('继续', 'nav_resume'), ('带我去停车场', None)])
def test_fast(text, tool):
    intent = parse_fast_path(text)
    assert (intent.tool if intent else None) == tool


@pytest.mark.parametrize('text,tool,args', [
    ('往前走两步', 'robot_move', {'distance_m': 1.0}), ('前进半米', 'robot_move', {'distance_m': .5}),
    ('前进一点五米', 'robot_move', {'distance_m': 1.5}), ('前进1.5米', 'robot_move', {'distance_m': 1.5}),
    ('右转', 'robot_turn', {'angle_deg': -90}), ('左转45度', 'robot_turn', {'angle_deg': 45}),
    ('带我去服务台', 'nav_go', {'destination': '服务台'}), ('去停车场怎么走', 'nav_go', {'destination': '停车场'}),
    ('打个招呼', 'robot_mimic', {'motion': 'GREET'}), ('准备一下', 'robot_prepare', {}),
    ('不去了', 'nav_cancel', {}), ('看看前面', 'describe_scene', {}),
])
def test_keywords(text, tool, args):
    intent, = parse_keywords(text, ['服务台'])
    assert intent.tool == tool and intent.args == args


@pytest.mark.asyncio
async def test_fast_bypasses_llm_and_dedup(assistant):
    queue = assistant.bus.subscribe()
    reply = await assistant.handle_text('停', 'robot', 'one')
    assert reply.via == 'fast' and reply.text == '已停下' and not assistant.llm.calls
    assert await assistant.handle_text('停', 'robot', 'one') is None
    events = [queue.get_nowait() for _ in range(queue.qsize())]
    assert len([e for e in events if e['type'] == 'voice.heard']) == 1
    assert len([e for e in events if e['type'] == 'assistant.reply']) == 1


@pytest.mark.asyncio
async def test_tools_order_and_history(assistant):
    assistant.llm.result = LLMResult('不应使用此内容', [ToolCall('robot_stand_up'), ToolCall('robot_mimic', {'motion': 'GREET'})])
    reply = await assistant.handle_text('站起并打招呼', 'text')
    assert reply.via == 'llm' and all(r['ok'] for r in reply.executed)
    assert [r['data']['status'] for r in reply.executed] == ['DONE', 'DONE']
    assert '不应使用' not in reply.text
    assistant.llm.result = LLMResult('你好')
    reply = await assistant.handle_text('你好', 'app')
    assert reply.text == '你好'
    messages, tools = assistant.llm.calls[-1]
    assert messages[1]['content'] == '站起并打招呼'
    assert '室内模式' in messages[0]['content'] and '服务台' in messages[0]['content']
    assert '多个工具' in messages[0]['content']
    assert tools == TOOLS
    assert 'robot_speak' not in [tool['function']['name'] for tool in TOOLS]


@pytest.mark.asyncio
async def test_outdoor_prompt_allows_route_planning(assistant):
    # 真机联调发现：旧提示只写「室外不移动」，模型会拒绝室外问路。
    await assistant.modes.set_mode(DemoMode.OUTDOOR)
    assistant.llm.result = LLMResult('好的')
    await assistant.handle_text('去张江科学会堂怎么走', 'text')
    prompt = assistant.llm.calls[-1][0][0]['content']
    assert '室外模式' in prompt and 'nav_go' in prompt and '不要拒绝' in prompt
    assert '服务台' not in prompt


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['unavailable', 'timeout', 'error', 'deadline'])
async def test_fallback(assistant, failure):
    if failure == 'unavailable':
        assistant.llm.available = False
    elif failure == 'deadline':
        assistant.settings.llm_timeout_s = .001
        assistant.llm.chat_tools = AsyncMock(side_effect=lambda *a: None)
        async def slow(*args):
            await asyncio.sleep(1)
        assistant.llm.chat_tools = slow
    else:
        assistant.llm.error = asyncio.TimeoutError() if failure == 'timeout' else LLMError()
    reply = await assistant.handle_text('站起', 'text')
    assert reply.via == 'keywords' and reply.executed[0]['ok']
    if failure == 'unavailable':
        assert not assistant.llm.calls


@pytest.mark.asyncio
async def test_mode_and_tool_validation(assistant):
    await assistant.modes.set_mode(DemoMode.OUTDOOR)
    assistant.llm.available = False
    reply = await assistant.handle_text('往前走', 'text')
    assert reply.text == '室外演示模式下机器狗不移动'
    assert not reply.executed[0]['ok']
    assistant.llm.available = True
    for call in [ToolCall('__dict__'), ToolCall('robot_move', {'distance_m': '1'}), ToolCall('nav_cancel', {'bad': 1})]:
        assistant.llm.result = LLMResult(tool_calls=[call])
        reply = await assistant.handle_text('执行', 'text')
        assert reply.executed[0]['error'] == 'INVALID_ARGS'


@pytest.mark.asyncio
async def test_scene_fallback_and_fake(assistant):
    assistant.obstacle_hints = lambda: '检测到：正前方 椅子；左侧 人'
    assistant.llm.available = False
    reply = await assistant.handle_text('看看前面', 'text')
    assert '正前方 椅子' in reply.text
    assistant.obstacle_hints = None
    reply = await assistant.handle_text('看看前面', 'text')
    assert reply.text == '我现在看不清前面，请注意安全'
    assistant.llm.available = True
    assistant.llm.result = LLMResult(tool_calls=[ToolCall('describe_scene')])
    reply = await assistant.handle_text('看看前面', 'text')
    assert reply.text == '正前方有色块'
    assert assistant.llm.images[0][0].startswith(b'\xff\xd8')
    assistant.llm.describe_image = AsyncMock(side_effect=LLMError())
    assistant.obstacle_hints = lambda: '左侧有人'
    assert '左侧有人' in (await assistant.handle_text('看看前面', 'text')).text


@pytest.mark.asyncio
async def test_voice_does_not_block_motion(assistant):
    assistant.llm.available = False
    entered, release = asyncio.Event(), asyncio.Event()
    async def speech(text):
        entered.set()
        await release.wait()
    assistant.gateway.speak = speech
    reply = await asyncio.wait_for(assistant.handle_text('带我去服务台', 'text'), .2)
    assert reply.executed[0]['ok']
    await entered.wait()
    assert assistant.navigation.status == 'ACTIVE'
    await until(lambda: assistant.gateway._active == 'move')
    stopped = await asyncio.wait_for(assistant.handle_text('停', 'text'), .2)
    assert stopped.text == '已停下'
    release.set()


@pytest.mark.asyncio
async def test_real_mock_speech_during_move(assistant):
    await assistant.gateway.stand_up()
    moving = asyncio.create_task(assistant.gateway.move(3))
    await until(lambda: assistant.gateway._active == 'move')
    assert (await assistant.gateway.speak('你好')).ok
    assert assistant.gateway._active == 'move'
    await assistant.gateway.stop()
    await moving


def test_voice_api_ws_audio(settings):
    settings.llm_enabled = False
    with TestClient(create_app(settings)) as client:
        with client.websocket_connect('/ws/app') as ws:
            assert ws.receive_json()['type'] == 'hello'
            reply = client.post('/api/voice/text', json={'text': '带我去服务台'}).json()
            assert reply['ok'] and reply['data']['via'] == 'keywords'
            assert client.get('/api/nav/current').json()['data']['status'] in {'ACTIVE', 'DONE'}
            heard = False
            while True:
                event = ws.receive_json()
                if event['type'] == 'voice.heard':
                    heard = True
                if event['type'] == 'assistant.reply':
                    assert heard and event['data']['intents'][0]['tool'] == 'nav_go'
                    break
        audio = client.post('/api/voice/audio', files={'file': ('test.wav', b'fake', 'audio/wav')}).json()
        assert audio['error'] == 'NOT_SUPPORTED'
        assert client.post('/api/voice/text', json={'text': '  '}).json()['error'] == 'INVALID_ARGS'


def test_asr_final_only_and_dedup(settings):
    settings.llm_enabled = False
    with TestClient(create_app(settings)) as client:
        async def inject():
            for final in (False, True, True):
                event = RobotEvent(type='asr', data={'text': '电量', 'is_final': final, 'event_id': 'asr-1'})
                for handler in client.app.state.gateway._handlers:
                    await handler(event)
            await asyncio.sleep(.01)
        client.portal.call(inject)
        assert len(client.app.state.assistant.history) == 1


@pytest.mark.asyncio
async def test_llm_wire_image_and_tool_parsing(settings):
    settings.deepseek_api_key = 'fake'
    message = SimpleNamespace(content='前方有色块', tool_calls=[SimpleNamespace(function=SimpleNamespace(name='robot_turn', arguments='{"angle_deg":45}'))])
    create = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=message)]))
    llm = LLMClient(settings, SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))
    result = await llm.chat_tools([{'role': 'user', 'content': '左转'}], TOOLS)
    assert result.tool_calls == [ToolCall('robot_turn', {'angle_deg': 45})]
    assert create.call_args.kwargs['tool_choice'] == 'auto'
    _, jpg = cv2.imencode('.jpg', np.zeros((1200, 1800, 3), np.uint8))
    assert await llm.describe_image(jpg.tobytes(), '提示') == '前方有色块'
    content = create.call_args.kwargs['messages'][0]['content']
    url = content[1]['image_url']['url']
    assert content[1]['type'] == 'image_url' and url.startswith('data:image/jpeg;base64,')
    decoded = cv2.imdecode(np.frombuffer(base64.b64decode(url.split(',')[1]), np.uint8), cv2.IMREAD_COLOR)
    assert max(decoded.shape[:2]) == 1024
    assert '不超过60字' in content[0]['text']
    create.side_effect = asyncio.TimeoutError()
    with pytest.raises(LLMError) as caught:
        await llm.chat_tools([], TOOLS)
    assert caught.value.is_timeout
    create.side_effect = ValueError()
    with pytest.raises(LLMError) as caught:
        await llm.describe_image(jpg.tobytes(), '')
    assert not caught.value.is_timeout
    with pytest.raises(LLMError):
        await llm.describe_image(b'bad', '')


@pytest.mark.asyncio
async def test_llm_malformed_args(settings):
    settings.deepseek_api_key = 'fake'
    for args in ('[]', '{broken'):
        message = SimpleNamespace(content='', tool_calls=[SimpleNamespace(function=SimpleNamespace(name='robot_move', arguments=args))])
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=message)])))))
        with pytest.raises(LLMError):
            await LLMClient(settings, client).chat_tools([], TOOLS)
    settings.deepseek_api_key = ''
    assert not LLMClient(settings).available


@pytest.mark.asyncio
async def test_outdoor_go_prepares_cached_route(assistant):
    assistant.llm.available = False
    assistant.settings.outdoor_default_origin = '121.5901,31.2032'
    await assistant.modes.set_mode(DemoMode.OUTDOOR)
    reply = await assistant.handle_text('带我去占位演示', 'text')
    assert reply.text == '室外演示我不移动，路线已经显示在手机上'
    assert reply.executed[0]['ok']
    assert assistant.navigation.route.cached
    assert not any(c.name in {'move', 'turn'} for c in assistant.scheduler.current().steps)


@pytest.mark.asyncio
async def test_stop_invalidates_inflight_llm(assistant):
    entered, release = asyncio.Event(), asyncio.Event()
    async def delayed(*args):
        entered.set()
        await release.wait()
        return LLMResult(tool_calls=[ToolCall('robot_stand_up')])
    assistant.llm.chat_tools = delayed
    pending = asyncio.create_task(assistant.handle_text('请站起来', 'text'))
    await entered.wait()
    await assistant.handle_text('停', 'text')
    release.set()
    reply = await pending
    assert reply.executed[0]['error'] == 'CANCELLED'
    assert (await assistant.gateway.get_state()).action == 'PASSIVE_DEFAULT'


@pytest.mark.asyncio
async def test_bounded_history_and_event_ids(assistant):
    assistant.llm.available = False
    for index in range(51):
        await assistant.handle_text('状态', 'robot', str(index))
    assert len(assistant.history) == assistant.settings.assistant_history_turns
    assert len(assistant._event_ids) == 50
    assert await assistant.handle_text('状态', 'robot', '50') is None
    assert await assistant.handle_text('状态', 'robot', '0') is not None


@pytest.mark.asyncio
async def test_runtime_failure_and_safety_limit(assistant):
    assistant.llm.available = False
    reply = await assistant.handle_text('前进4米', 'text')
    assert reply.executed[0]['error'] == 'INVALID_ARGS'
    assistant.gateway._fail.add('stand_up')
    reply = await assistant.handle_text('站起', 'text')
    assert reply.executed[0]['error'] == 'MOCK_FAIL'
    assert reply.text == '模拟命令失败'


@pytest.mark.asyncio
@pytest.mark.parametrize('text', ['前进一百米', '前进一点米', '前进两百米'])
async def test_invalid_quantity_never_becomes_small_motion(assistant, text):
    assistant.llm.available = False
    reply = await assistant.handle_text(text, 'text')
    assert reply.executed[0]['error'] == 'INVALID_ARGS'
    assert assistant.scheduler.current() is None
