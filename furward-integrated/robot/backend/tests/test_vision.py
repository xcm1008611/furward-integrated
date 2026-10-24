import asyncio
import time
from unittest.mock import AsyncMock

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.errors import ApiError
from app.main import create_app
from app.models import CmdResult, DemoMode, NavPlanRequest
from app.services.detector import Detection, NullDetector, OnnxYoloDetector, create_detector, postprocess
from app.services.obstacle import Debouncer, MockSource, ObstacleMonitor, VideoFileSource, Zone, classify
from test_navigation import nav, until, plan_indoor
from test_assistant import assistant


@pytest.mark.parametrize('box,expected', [((0, 0, .1, 1), 'clear'), ((.4, .3, .6, .9), 'stop'), ((.4, .65, .6, .9), 'caution')])
def test_classify(box, expected):
    assert classify([Detection('person', .9, box)], Zone(), .35, .2)[0] == expected


@pytest.mark.parametrize('x,position', [(.3, '左侧'), (.5, '正前方'), (.7, '右侧')])
def test_positions(x, position):
    _, relevant = classify([Detection('chair', .8, (x-.05, .5, x+.05, .95))], Zone(), .35, .2)
    assert relevant[0]['position'] == position


def test_debounce():
    d = Debouncer(2, 1.5)
    assert d.update('clear', 0) == 'clear'
    assert d.update('stop', .1) == 'clear'
    assert d.update('clear', .2) == 'clear'
    assert d.update('stop', .3) == 'clear'
    assert d.update('stop', .4) == 'stop'
    assert d.update('clear', .5) == 'stop'
    assert d.update('clear', 1.9) == 'stop'
    assert d.update('caution', 2) == 'stop'
    assert d.update('clear', 2.1) == 'stop'
    assert d.update('clear', 3.7) == 'clear'
    assert d.update('unknown', 4) == 'unknown'


@pytest.mark.parametrize('transpose', [False, True])
def test_postprocess(transpose):
    output = np.zeros((1, 84, 4), np.float32)
    output[0, :4, :] = np.array([[320, 320, 200, 100], [322, 320, 200, 100], [100, 200, 20, 20], [400, 300, 100, 100]]).T
    output[0, 4, :] = [.9, .8, .2, 0]
    output[0, 6, 3] = .99  # car 不在白名单中。
    if transpose:
        output = output.transpose(0, 2, 1)
    detections = postprocess(output, (320, 640), 1, (0, 160), .4, ['person'])
    assert len(detections) == 1
    assert detections[0].box == pytest.approx((220/640, 110/320, 420/640, 210/320))


def test_detector_missing(settings, tmp_path):
    settings.detector_model_path = str(tmp_path / 'missing.onnx')
    detector = create_detector(settings)
    assert isinstance(detector, NullDetector) and not detector.available
    assert detector.detect(None) == []


def test_preprocess():
    detector = OnnxYoloDetector.__new__(OnnxYoloDetector)
    detector.size, detector.conf, detector.classes, detector.input_name = 640, .4, ['person'], 'images'
    class Session:
        def run(self, _, inputs):
            tensor = inputs['images']
            assert tensor.shape == (1, 3, 640, 640)
            assert tensor.dtype == np.float32
            assert tensor[0, :, 320, 320] == pytest.approx([1, 0, 0])
            assert tensor[0, :, 0, 0] == pytest.approx([114/255]*3)
            return [np.zeros((1, 84, 0), np.float32)]
    detector.session = Session()
    frame = np.zeros((320, 640, 3), np.uint8)
    frame[:, :, 2] = 255
    assert detector.detect(frame) == []


def make_monitor(nav):
    source = MockSource(nav.settings)
    monitor = ObstacleMonitor(nav.settings, source, NullDetector(), nav, nav.scheduler.gateway, nav.modes, nav.bus)
    return monitor, source


async def feed(monitor, source, level):
    source.inject(level)
    source._put(np.zeros((48, 64, 3), np.uint8))
    await monitor.tick()
    await asyncio.sleep(0)


@pytest.mark.asyncio
@pytest.mark.parametrize('auto', [False, True])
async def test_obstacle_navigation(nav, auto):
    nav.settings.mock_time_scale = .05
    nav.settings.clear_hold_s = .01
    nav.settings.obstacle_auto_resume = auto
    monitor, source = make_monitor(nav)
    speak = nav.scheduler.gateway.speak = AsyncMock(return_value=CmdResult(ok=True))
    try:
        await feed(monitor, source, 'clear')
        await plan_indoor(nav, 'coffee')
        await nav.execute()
        await until(lambda: nav.scheduler.gateway._active == 'move')
        await feed(monitor, source, 'stop')
        assert nav.status == 'ACTIVE'
        await monitor.tick()  # 同一帧不能累计确认次数。
        assert nav.status == 'ACTIVE'
        await feed(monitor, source, 'stop')
        assert nav.status == 'PAUSED' and nav.pause_reason == 'obstacle'
        assert '前方有障碍，我先停一下' in [c.args[0] for c in speak.call_args_list]
        await feed(monitor, source, 'clear')
        assert monitor.level == 'stop'
        await asyncio.sleep(.02)
        await feed(monitor, source, 'clear')
        assert nav.status == ('ACTIVE' if auto else 'PAUSED')
        assert any('已通畅' in c.args[0] for c in speak.call_args_list)
        count = speak.call_count
        await feed(monitor, source, 'clear')
        assert speak.call_count == count
    finally:
        await monitor.close()


@pytest.mark.asyncio
async def test_user_pause_not_resumed(nav):
    nav.settings.obstacle_auto_resume = True
    nav.settings.clear_hold_s = 0
    monitor, source = make_monitor(nav)
    try:
        await plan_indoor(nav)
        await nav.execute()
        await nav.pause('user')
        await feed(monitor, source, 'clear')
        assert nav.status == 'PAUSED' and nav.pause_reason == 'user'
    finally:
        await monitor.close()


@pytest.mark.asyncio
async def test_unknown_and_logs(nav):
    monitor, source = make_monitor(nav)
    queue = nav.bus.subscribe()
    try:
        await plan_indoor(nav)
        await nav.execute()
        await until(lambda: nav.status == 'DONE')
        logs = [queue.get_nowait() for _ in range(queue.qsize())]
        assert sum(e['type'] == 'log' and e['data']['text'] == '障碍物识别未启用' for e in logs) == 1
        await feed(monitor, source, 'clear')
        source._received -= 3
        assert monitor.state()['level'] == 'unknown'
        await monitor.tick()
        assert monitor.level == 'unknown' and monitor.hints_text() == ''
        assert await monitor.latest_jpeg() is None
    finally:
        await monitor.close()


@pytest.mark.asyncio
async def test_scene_fallback(assistant):
    assistant.gateway.snapshot = AsyncMock(return_value=None)
    assistant.snapshot_fallback = AsyncMock(return_value=b'jpeg')
    from app.services.assistant import TOOL_TABLE
    _, reply = await assistant._scene(TOOL_TABLE['describe_scene'], {})
    assert reply == '正前方有色块'
    assert assistant.llm.images[-1][0] == b'jpeg'


def test_api(settings):
    with TestClient(create_app(settings)) as client:
        async def ready():
            await until(lambda: client.app.state.obstacle_monitor.enabled)
        client.portal.call(ready)
        assert client.get('/api/vision/obstacle').json()['data']['source'] == 'mock'
        jpeg = client.get('/api/vision/snapshot.jpg')
        assert jpeg.headers['content-type'] == 'image/jpeg' and jpeg.content.startswith(b'\xff\xd8')
        assert client.post('/api/debug/obstacle', json={'level': 'stop'}).json()['ok']
        assert client.post('/api/debug/obstacle', json={'level': 'bad'}).json()['error'] == 'INVALID_ARGS'
    settings.obstacle_source = 'none'
    with TestClient(create_app(settings)) as client:
        for path in ('obstacle', 'snapshot.jpg', 'stream'):
            assert client.get('/api/vision/'+path).json()['error'] == 'NOT_SUPPORTED'
        assert client.post('/api/debug/obstacle', json={'level': 'stop'}).json()['error'] == 'NOT_SUPPORTED'


@pytest.mark.asyncio
async def test_stream_first_chunk_disconnect(settings):
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        await until(lambda: app.state.obstacle_monitor.source.healthy)
        disconnected = asyncio.Event()
        messages = []
        async def receive():
            await disconnected.wait()
            return {'type': 'http.disconnect'}
        async def send(message):
            messages.append(message)
            if message['type'] == 'http.response.body' and message.get('body'):
                disconnected.set()
        scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.0'}, 'http_version': '1.1',
                 'method': 'GET', 'scheme': 'http', 'path': '/api/vision/stream', 'raw_path': b'/api/vision/stream',
                 'query_string': b'', 'headers': [], 'client': ('test', 1), 'server': ('test', 80)}
        await asyncio.wait_for(app(scope, receive, send), 1)
        headers = dict(messages[0]['headers'])
        assert headers[b'content-type'] == b'multipart/x-mixed-replace; boundary=frame'
        body = next(m['body'] for m in messages if m['type'] == 'http.response.body')
        assert b'Content-Type: image/jpeg\r\n' in body and b'\xff\xd8' in body


def test_nonmock_injection(settings, monkeypatch):
    settings.obstacle_source = 'video'
    monkeypatch.setattr(VideoFileSource, 'start', lambda self: None)
    with TestClient(create_app(settings)) as client:
        assert client.post('/api/debug/obstacle', json={'level': 'stop'}).json()['error'] == 'NOT_SUPPORTED'
        status = client.get('/api/vision/obstacle').json()['data']
        assert not status['enabled'] and status['level'] == 'unknown'


@pytest.mark.asyncio
async def test_video_loop_and_rotation(settings, tmp_path):
    path = str(tmp_path / 'short.avi')
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'MJPG'), 30, (64, 48))
    assert writer.isOpened()
    writer.write(np.full((48, 64, 3), 100, np.uint8))
    writer.release()
    settings.video_path, settings.frame_rotate = path, 90
    source = VideoFileSource(settings)
    source.start()
    try:
        await until(lambda: source.healthy)
        first = source.latest()[1]
        await asyncio.sleep(.1)
        assert source.latest()[1] > first
        assert source.latest()[0].shape[:2] == (64, 48)
    finally:
        await asyncio.to_thread(source.stop)
    assert not source.healthy


@pytest.mark.asyncio
async def test_background_monitor_lifecycle(settings):
    settings.mock_time_scale = .1
    settings.obstacle_fps = 100
    settings.clear_hold_s = .02
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        state = app.state
        monitor = state.obstacle_monitor
        state.gateway.speak = AsyncMock(return_value=CmdResult(ok=True))
        await until(lambda: monitor.enabled)
        await state.navigation.plan(NavPlanRequest(mode='indoor', to='coffee'))
        await state.navigation.execute()
        await until(lambda: state.gateway._active == 'move')
        monitor.source.inject('stop')
        await until(lambda: state.navigation.status == 'PAUSED')
        assert state.navigation.pause_reason == 'obstacle'
        monitor.source.inject('clear')
        await until(lambda: any('已通畅' in call.args[0] for call in state.gateway.speak.call_args_list))
        assert state.navigation.status == 'PAUSED'
        assert app.state.obstacle_hints == monitor.hints_text
    assert not monitor.source._thread.is_alive()
    assert monitor._runner.done()


@pytest.mark.asyncio
async def test_inference_failure_unknown(nav):
    monitor, source = make_monitor(nav)
    class BrokenDetector:
        available = True
        def detect(self, frame):
            raise ValueError('模拟推理失败')
    # 使用普通帧源以覆盖真实检测路径，不访问视频设备。
    from app.services.obstacle import ObstacleSource
    monitor.source = ObstacleSource(nav.settings)
    monitor.detector = BrokenDetector()
    monitor.source._put(np.zeros((48, 64, 3), np.uint8))
    await monitor.tick()
    assert monitor.state()['level'] == 'unknown'
    assert not monitor.enabled and monitor.hints_text() == ''
    await monitor.close()
