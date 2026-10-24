import asyncio
import logging
import threading
import time
from contextlib import suppress
from dataclasses import asdict, dataclass

import cv2
import numpy as np

from app.models import DemoMode
from app.services.detector import Detection
from app.services.indoor import data_path

logger = logging.getLogger(__name__)
CHINESE = dict(zip(
    ['person', 'chair', 'bench', 'suitcase', 'backpack', 'handbag', 'bicycle', 'potted plant', 'dining table', 'couch', 'dog', 'bottle', 'box'],
    ['人', '椅子', '长椅', '行李箱', '背包', '手提包', '自行车', '盆栽', '餐桌', '沙发', '狗', '瓶子', '箱子']))


class ObstacleSource:
    def __init__(self, settings):
        self.settings = settings
        self._lock = threading.Lock()
        self._latest = None
        self._received = 0.0
        self._stop = threading.Event()
        self._thread = None

    def latest(self):
        with self._lock:
            return self._latest

    @property
    def healthy(self):
        return self._latest is not None and time.monotonic() - self._received < self.settings.camera_health_s

    def _put(self, frame):
        rotation = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}
        if self.settings.frame_rotate:
            frame = cv2.rotate(frame, rotation[self.settings.frame_rotate])
        with self._lock:
            self._latest = (frame, time.time())
            self._received = time.monotonic()

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name=type(self).__name__)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join()
        with self._lock:
            self._latest = None


class RtspSource(ObstacleSource):
    def _open(self):
        return cv2.VideoCapture(self.settings.rtsp_url, cv2.CAP_FFMPEG, [
            cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, self.settings.camera_timeout_ms,
            cv2.CAP_PROP_READ_TIMEOUT_MSEC, self.settings.camera_timeout_ms])

    def _run(self):
        while not self._stop.is_set():
            capture = None
            try:
                capture = self._open()
                while capture.isOpened() and not self._stop.is_set():
                    ok, frame = capture.read()
                    if not ok:
                        break
                    self._put(frame)
            except Exception:
                logger.exception('相机读取失败')
            finally:
                if capture is not None:
                    capture.release()
            if not self._stop.is_set():
                logger.warning('相机断流，将重连')
                self._stop.wait(self.settings.camera_reconnect_s)


class VideoFileSource(RtspSource):
    def _open(self):
        return cv2.VideoCapture(str(data_path(self.settings.video_path)))

    def _run(self):
        while not self._stop.is_set():
            capture = self._open()
            try:
                fps = capture.get(cv2.CAP_PROP_FPS)
                fps = fps if np.isfinite(fps) and fps > 0 else self.settings.obstacle_fps
                while capture.isOpened() and not self._stop.is_set():
                    started = time.monotonic()
                    ok, frame = capture.read()
                    if not ok:
                        # 部分容器不能准确 seek 回首帧，重开保证短视频也能循环。
                        capture.release()
                        capture = self._open()
                        ok, frame = capture.read()
                        if not ok:
                            break
                    self._put(frame)
                    self._stop.wait(max(0, 1/fps - (time.monotonic()-started)))
            finally:
                capture.release()
            self._stop.wait(self.settings.camera_reconnect_s)


class MockSource(ObstacleSource):
    def __init__(self, settings):
        super().__init__(settings)
        self._detections = []

    def inject(self, level, label='box', position='center'):
        x = {'left': .3, 'center': .5, 'right': .7}[position]
        height = self.settings.stop_height_ratio if level == 'stop' else self.settings.caution_height_ratio
        with self._lock:
            self._detections = [] if level == 'clear' else [Detection(label, 1.0, (x-.1, 1-height, x+.1, 1.0))]

    def detections(self):
        with self._lock:
            return list(self._detections)

    def _run(self):
        while not self._stop.is_set():
            frame = np.full((480, 640, 3), 170, np.uint8)
            cv2.putText(frame, 'MOCK CAMERA', (40, 120), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (40, 40, 40), 2)
            cv2.putText(frame, time.strftime('%H:%M:%S'), (40, 170), cv2.FONT_HERSHEY_SIMPLEX, .8, (40, 40, 40), 2)
            self._put(frame)
            self._stop.wait(1/self.settings.obstacle_fps)


@dataclass(frozen=True)
class Zone:
    top_y: float = .55
    top_left: float = .35
    top_right: float = .65
    bottom_left: float = .15
    bottom_right: float = .85

    @classmethod
    def from_settings(cls, settings):
        return cls(**{key: getattr(settings, 'zone_' + key) for key in cls.__dataclass_fields__})


def classify(detections, zone, stop_ratio, caution_ratio):
    relevant, level = [], 'clear'
    for detection in detections:
        x1, y1, x2, y2 = detection.box
        x = (x1+x2)/2
        # 底边中点进入梯形才算挡路，避免侧方大物体误触发。
        if not zone.top_y <= y2 <= 1:
            continue
        t = (y2-zone.top_y)/(1-zone.top_y)
        left = zone.top_left + t*(zone.bottom_left-zone.top_left)
        right = zone.top_right + t*(zone.bottom_right-zone.top_right)
        if not left <= x <= right:
            continue
        relevant.append({**asdict(detection), 'position': '左侧' if x < .4 else '右侧' if x > .6 else '正前方'})
        if y2-y1 >= stop_ratio:
            level = 'stop'
        elif y2-y1 >= caution_ratio and level != 'stop':
            level = 'caution'
    return level, relevant


class Debouncer:
    def __init__(self, confirm_frames, clear_hold_s):
        self.confirm_frames, self.clear_hold_s = confirm_frames, clear_hold_s
        self.level, self.stops, self.clear_since = 'unknown', 0, None

    def update(self, raw, now):
        self.stops = self.stops + 1 if raw == 'stop' else 0
        if raw == 'unknown':
            self.level, self.clear_since = 'unknown', None
        elif self.level == 'stop':
            if raw == 'clear':
                if self.clear_since is None:
                    self.clear_since = now
                if now - self.clear_since >= self.clear_hold_s:
                    self.level = 'clear'
            else:
                self.clear_since = None
        elif raw == 'stop':
            self.clear_since = None
            if self.stops >= self.confirm_frames:
                self.level = 'stop'
        else:
            self.level = raw
        return self.level


class ObstacleMonitor:
    def __init__(self, settings, source, detector, navigation, gateway, modes, bus):
        self.settings, self.source, self.detector = settings, source, detector
        self.navigation, self.gateway, self.modes, self.bus = navigation, gateway, modes, bus
        self.zone = Zone.from_settings(settings)
        self.debounce = Debouncer(settings.stop_confirm_frames, settings.clear_hold_s)
        self.level, self.detections, self.frame_ts = 'unknown', [], None
        self._inference_ok = True
        self._last_publish = 0
        self._runner = None
        self._speech = set()
        self._clear_announced = False
        self._disabled_logged = False
        self._recovery_since = None
        navigation.obstacle_monitor = self

    @property
    def enabled(self):
        return self.source.healthy and self._inference_ok and (isinstance(self.source, MockSource) or self.detector.available)

    def state(self):
        return {'level': self.level if self.enabled else 'unknown', 'detections': self.detections if self.enabled else [],
                'enabled': self.enabled, 'source': self.settings.obstacle_source,
                'detector': 'mock' if isinstance(self.source, MockSource) else type(self.detector).__name__ if self.detector.available else 'unavailable',
                'frame_ts': self.frame_ts}

    async def navigation_started(self):
        self._disabled_logged = False
        await self._log_disabled()

    async def _log_disabled(self):
        if not self.enabled and not self._disabled_logged:
            self._disabled_logged = True
            await self.bus.log('info', '障碍物识别未启用')

    def start(self):
        self.source.start()
        self._runner = asyncio.create_task(self._run())

    def _say(self, text):
        async def speak():
            try:
                result = await self.gateway.speak(text)
                if not result.ok:
                    await self.bus.log('error', result.message or '障碍提示播报失败')
            except Exception:
                await self.bus.log('error', '障碍提示播报失败')
        task = asyncio.create_task(speak())
        self._speech.add(task)
        task.add_done_callback(self._speech.discard)

    async def tick(self):
        now = time.monotonic()
        previous = self.level
        latest = self.source.latest()
        raw = 'unknown'
        if latest and self.source.healthy and (isinstance(self.source, MockSource) or self.detector.available):
            frame, ts = latest
            if ts != self.frame_ts:
                self.frame_ts = ts
                try:
                    detections = self.source.detections() if isinstance(self.source, MockSource) else await asyncio.to_thread(self.detector.detect, frame)
                    self._inference_ok = True
                    if self.source.healthy:
                        raw, self.detections = classify(detections, self.zone, self.settings.stop_height_ratio, self.settings.caution_height_ratio)
                        self.level = self.debounce.update(raw, now)
                except Exception:
                    self._inference_ok = False
                    logger.exception('障碍物检测失败')
            else:
                raw = None
        if not self.enabled:
            self.detections = []
            self.level = self.debounce.update('unknown', now)
        nav = self.navigation
        if nav.status == 'ACTIVE':
            await self._log_disabled()
        if self.level == 'stop' and self.enabled and self.modes.mode == DemoMode.INDOOR and nav.status == 'ACTIVE':
            await nav.pause('obstacle')
            self._clear_announced = False
            self._say('前方有障碍，我先停一下')
            await self.bus.log('info', '前方有障碍，已暂停导航')
        # 断流后重新获得清晰画面也必须重新满足连续清除时间。
        if raw is not None:
            if raw == 'clear' and self.enabled:
                if self._recovery_since is None:
                    self._recovery_since = now
            else:
                self._recovery_since = None
        if (self.enabled and self.level == 'clear' and self._recovery_since is not None
                and now-self._recovery_since >= self.settings.clear_hold_s
                and nav.status == 'PAUSED' and nav.pause_reason == 'obstacle' and not self._clear_announced):
            self._clear_announced = True
            if self.settings.obstacle_auto_resume:
                await nav.resume()
                self._say('前方已通畅，继续出发')
            else:
                self._say('前方已通畅，说"继续"出发')
        if previous != self.level or now-self._last_publish >= .5:
            await self.bus.publish('obstacle.update', self.state())
            self._last_publish = now

    async def _run(self):
        while True:
            started = time.monotonic()
            try:
                await self.tick()
            except Exception:
                logger.exception('障碍物监控循环异常')
                await self.bus.log('error', '障碍物监控异常，将继续重试')
            await asyncio.sleep(max(0, 1/self.settings.obstacle_fps-(time.monotonic()-started)))

    def hints_text(self):
        if not self.enabled or self.frame_ts is None or self.source.latest() is None:
            return ''
        return '检测到：' + '；'.join(f"{d['position']} {CHINESE.get(d['label'], d['label'])}" for d in self.detections) if self.detections else '前方暂时没有检测到障碍物'

    def _jpeg(self, annotated):
        latest = self.source.latest()
        if latest is None or not self.source.healthy:
            return None
        frame = latest[0].copy()
        if annotated:
            h, w = frame.shape[:2]
            z = self.zone
            points = np.array([(z.top_left*w, z.top_y*h), (z.top_right*w, z.top_y*h), (z.bottom_right*w, h-1), (z.bottom_left*w, h-1)], np.int32)
            cv2.polylines(frame, [points], True, (255, 180, 0), 2)
            state = self.state()
            for d in state['detections']:
                x1, y1, x2, y2 = [int(v*s) for v, s in zip(d['box'], (w, h, w, h))]
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 150, 255), 2)
                cv2.putText(frame, d['label'], (x1, max(40, y1)), cv2.FONT_HERSHEY_SIMPLEX, .6, (0, 0, 0), 2)
            color = {'clear': (40, 180, 40), 'caution': (0, 220, 255), 'stop': (40, 40, 230), 'unknown': (120, 120, 120)}[state['level']]
            cv2.rectangle(frame, (0, 0), (w, 30), color, -1)
            cv2.putText(frame, state['level'], (10, 22), cv2.FONT_HERSHEY_SIMPLEX, .7, (255, 255, 255), 2)
        ok, encoded = cv2.imencode('.jpg', frame)
        return encoded.tobytes() if ok else None

    async def latest_jpeg(self):
        return await asyncio.to_thread(self._jpeg, False)

    async def annotated_jpeg(self):
        return await asyncio.to_thread(self._jpeg, True)

    async def close(self):
        if self._runner:
            self._runner.cancel()
            with suppress(asyncio.CancelledError):
                await self._runner
        for task in self._speech:
            task.cancel()
        await asyncio.gather(*self._speech, return_exceptions=True)
        await asyncio.to_thread(self.source.stop)
