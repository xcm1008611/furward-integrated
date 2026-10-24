import asyncio
import base64
import math
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

from .base import BaseAdapter, result, command_id

LOCOMOTION = 'QUADRUPED_LOCOMOTION_DEFAULT'
MIMICS = {'GREET', 'HEED', 'GLANCE', 'HANDSHAKE', 'PONDER'}
RESERVED = {'rc', 'pnc', 'interaction', 'vr', 'app_proxy', 'coreon_fusion'}


def valid_velocity(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and (value == 0 or abs(value) >= .2))


def completed_ratio(elapsed_s, duration_s):
    return min(1.0, max(0.0, elapsed_s / duration_s)) if duration_s > 0 else 1.0


class T1Adapter(BaseAdapter):
    def __init__(self, sdk_path='', camera_id='head_stereo_left', input_source_name='moonstone_nav', input_source_priority=30, mimic_operation=0):
        if not input_source_name.strip() or input_source_name in RESERVED:
            raise ValueError('输入源名称为空或与系统内置名称冲突')
        if not 20 <= input_source_priority <= 39:
            raise ValueError('输入源优先级必须在 20–39 范围内')
        if type(mimic_operation) is not int or mimic_operation not in (0, 2):
            raise ValueError('互动动作 operation 必须为 0 或 2')
        self.mimic_operation = mimic_operation
        self.sdk_path, self.camera_id = sdk_path, camera_id
        self.source, self.priority = input_source_name, input_source_priority
        self.node = self.switch_node = self.executor = self.thread = None
        self.ros = None
        self.clients = {}
        self.registered = False
        self.state = {'battery': None, 'action': 'UNKNOWN', 'action_status': 'UNKNOWN', 'busy': False}
        self.state_lock = threading.Lock()
        self.velocity_lock = threading.Lock()
        self.switch_lock = threading.Lock()
        self.target = (0.0, 0.0)
        self.publishing = False
        self.cancel = threading.Event()
        self.motion_active = False
        self.started = self.duration = 0.0
        self.stop_detail = None
        self.poller = None
        self.camera_lock = asyncio.Lock()
        self.zero_until = 0.0
        self.asr_handler = lambda data: None

    async def start(self):
        sdk_python = Path(self.sdk_path).expanduser() / 'examples' / 'python'
        if not (sdk_python / 'common' / 'mc_action_switcher.py').is_file():
            return result(False, error='NOT_FOUND', message='找不到 SDK 状态机模块，请设置 T1_SDK_PATH 为 primebot-t1-sdk 根目录')
        # 依据 SDK 的 examples/python/common/mc_action_switcher.py；仅引用外部 SDK。
        sys.path.insert(0, str(sdk_python.resolve()))
        try:
            import rclpy
            from rclpy.executors import MultiThreadedExecutor
            from rclpy.qos import QoSProfile, ReliabilityPolicy
            from aimdk_msgs.msg import McLocomotionVelocity, Bms, AsrResult, CommonState, TtsPriorityLevel
            from aimdk_msgs.srv import SetMcInputSource, GetMcAction, SetMcMotion, PlayTts, LedStripCommand, CaptureJpegImage
            from common.mc_action_switcher import McActionSwitcher, McActionSwitchOptions
        except ImportError as exc:
            return result(False, error='NOT_SUPPORTED', message=f'无法加载 ROS2 或 SDK，请先 source 环境：{exc}')
        self.ros, self.velocity_type = rclpy, McLocomotionVelocity
        self.common_state, self.tts_priority = CommonState, TtsPriorityLevel
        self.switch_options = McActionSwitchOptions
        rclpy.init()
        try:
            self.node = rclpy.create_node('moonstone_bridge')
            # switcher 自己 spin，此节点绝不能加入主 executor。
            self.switch_node = rclpy.create_node('moonstone_switcher')
            self.switcher = McActionSwitcher(self.switch_node)
            self.types = {cls.__name__: cls for cls in (SetMcInputSource, GetMcAction, SetMcMotion, PlayTts, LedStripCommand, CaptureJpegImage)}
            # 依据各同名 .srv、get_jpg.py 与 mc_locomotion_velocity.py。
            for name, cls in self.types.items():
                service = '/aima/hal/camera/CaptureJpegImage' if name == 'CaptureJpegImage' else '/aimdk_5Fmsgs/srv/' + name
                self.clients[name] = self.node.create_client(cls, service)
            self.publisher = self.node.create_publisher(McLocomotionVelocity, '/aima/mc/locomotion/velocity', 10)
            self.timer = self.node.create_timer(.02, self._publish)
            # 依据 get_bms_state.py、get_asr_result.py：Best Effort。
            qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT)
            self.node.create_subscription(Bms, '/aima/hal/bms/state', self._battery, qos)
            self.node.create_subscription(AsrResult, '/aima/agent/asr_result', self._asr, qos)
            self.executor = MultiThreadedExecutor()
            self.executor.add_node(self.node)
            self.thread = threading.Thread(target=self.executor.spin, name='moonstone_ros', daemon=True)
            self.thread.start()
            await self._input(1003)
            # ADD 超时也可能已注册，退出时仍尝试 DELETE。
            self.registered = True
            response = await self._input(1001)
            if response.response.header.code != 0:
                raise RuntimeError('注册输入源失败')
            self.registered = True
            self.poller = asyncio.create_task(self._poll())
            return result()
        except Exception:
            await self.close()
            raise

    async def _thread_call(self, fn, cancel_switch=False):
        task = asyncio.create_task(asyncio.to_thread(fn))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # to_thread 不能强杀；等有限时调用退出后才能销毁节点。
            if cancel_switch:
                self.cancel.set()
            await task
            raise

    async def _call(self, name, request, timeout=3.0):
        def call():
            client = self.clients[name]
            if not client.wait_for_service(timeout_sec=timeout):
                raise TimeoutError('机器人服务未就绪')
            future = client.call_async(request)
            finished = threading.Event()
            future.add_done_callback(lambda _: finished.set())
            if not finished.wait(timeout):
                future.cancel()
                raise TimeoutError('机器人服务响应超时')
            response = future.result()
            if response is None:
                raise RuntimeError('机器人服务返回空响应')
            return response
        return await self._thread_call(call)

    def _stamp(self):
        return self.node.get_clock().now().to_msg()

    async def _input(self, operation):
        # 依据 mc_locomotion_velocity.py / SetMcInputSource.srv。
        req = self.types['SetMcInputSource'].Request()
        req.request.header.stamp = self._stamp()
        req.action.value = operation
        req.input_source.name = self.source
        req.input_source.priority = self.priority
        req.input_source.timeout = 1000
        return await self._call('SetMcInputSource', req)

    def _battery(self, msg):
        # 依据 Bms.msg。
        with self.state_lock:
            self.state['battery'] = msg.remaining_capacity_percentage

    def _asr(self, msg):
        # 依据 AsrResult.msg；event_id 去重由后端助手统一完成。
        if msg.is_final:
            self.asr_handler({'text': msg.text, 'event_id': msg.event_id,
                              'confidence': msg.confidence, 'is_final': True})

    async def _action(self):
        # 依据 GetMcAction.srv / McActionInfo.msg / McActionStatus.msg。
        req = self.types['GetMcAction'].Request()
        req.request.header.stamp = self._stamp()
        response = await self._call('GetMcAction', req)
        if response.header.code != 0:
            raise RuntimeError('读取机器人动作失败')
        info = response.info
        with self.state_lock:
            self.state['action'] = info.action_desc
            self.state['action_status'] = {100: 'RUNNING', 200: 'TRANSITION', 0: 'IDLE'}.get(info.status.value, 'UNKNOWN')
        return info.action_desc, info.status.value

    async def _poll(self):
        while True:
            try:
                await self._action()
            except Exception:
                with self.state_lock:
                    self.state['action_status'] = 'UNKNOWN'
            await asyncio.sleep(1)

    async def get_state(self):
        with self.state_lock:
            return result(detail=dict(self.state))

    async def _switch(self, target):
        self.cancel.clear()
        def switch():
            with self.switch_lock:
                # 依据 mc_action_switcher.py；取消回调防止停止后继续规划下一跳。
                return self.switcher.switch_to(target, self.switch_options(
                    source='moonstone', total_timeout=30.0, should_cancel=self.cancel.is_set))
        with self.state_lock:
            self.state['busy'] = True
        try:
            switched = await self._thread_call(switch, cancel_switch=True)
            if self.cancel.is_set():
                return result(False, error='CANCELLED', message='姿态切换已取消')
            return result() if switched.success else result(False, {'sdk_message': switched.message}, 'ACTION_SWITCH_FAILED', '机器人姿态切换失败')
        finally:
            with self.state_lock:
                self.state['busy'] = False

    async def stand_up(self):
        return await self._switch(LOCOMOTION)

    async def posture(self, name):
        targets = {'stand': LOCOMOTION, 'sit': 'QUADRUPED_SIT_DOWN_DEFAULT', 'lie_down': 'QUADRUPED_GET_DOWN_DEFAULT'}
        if name not in targets:
            return result(False, error='INVALID_ARGS', message='姿态不在允许的白名单内')
        return await self._switch(targets[name])

    async def mimic(self, motion):
        if motion not in MIMICS:
            return result(False, error='INVALID_ARGS', message='动作不在允许的白名单内')
        ready = await self.stand_up()
        if not ready['ok']:
            return ready
        # 依据 set_mc_action.py、SetMcMotion.srv、CommonTaskResponse.msg。
        req = self.types['SetMcMotion'].Request()
        req.header.stamp = self._stamp()
        req.source, req.motion = 'moonstone', 'QUAD_MIMIC_' + motion
        req.type, req.interrupt = req.MIMIC_QY, False
        # 待真机验证: 默认不设置，与官方示例一致；动作不执行时可显式指定 EXECUTION。
        if self.mimic_operation:
            req.operation = self.mimic_operation
        response = (await self._call('SetMcMotion', req)).response
        detail = {'code': response.header.code, 'state': response.state.value,
                  'reason': response.state.reason, 'task_id': response.task_id}
        if response.header.code != 0 or response.state.value not in (self.common_state.SUCCESS, self.common_state.RUNNING):
            return result(False, detail, 'UPSTREAM_ERROR', '机器人未接受互动动作')
        # 待真机验证: 快速动作可能在首次轮询前完成，按约定观察 3 秒。
        with self.state_lock:
            self.state['busy'] = True
        try:
            leave_deadline = time.monotonic() + 3
            while time.monotonic() < leave_deadline:
                if self.cancel.is_set():
                    return result(False, detail, 'CANCELLED', '互动动作等待已取消')
                action, status = await self._action()
                if action != LOCOMOTION:
                    break
                await asyncio.sleep(.2)
            finish_deadline = time.monotonic() + 20
            while time.monotonic() < finish_deadline:
                if self.cancel.is_set():
                    return result(False, detail, 'CANCELLED', '互动动作等待已取消')
                action, status = await self._action()
                if action == LOCOMOTION and status == 100:
                    return result(detail=detail)
                await asyncio.sleep(.2)
            await self.stop()
            return result(False, detail, 'TIMEOUT', '互动动作完成等待超时')
        finally:
            with self.state_lock:
                self.state['busy'] = False

    def _publish(self):
        # 依据 McLocomotionVelocity.msg / mc_locomotion_velocity.py。
        with self.velocity_lock:
            if not self.publishing:
                return
            msg = self.velocity_type()
            msg.header.stamp = self._stamp()
            msg.source = self.source
            msg.forward_velocity, msg.angular_velocity = self.target
            msg.lateral_velocity = msg.pitch_velocity = msg.level = 0.0
            self.publisher.publish(msg)

    async def _velocity(self, forward, angular, duration):
        if not valid_velocity(forward) or not valid_velocity(angular) or not math.isfinite(duration) or duration < 0:
            return result(False, error='INVALID_ARGS', message='速度必须为 0 或绝对值不小于 0.2，持续时间必须是非负有限数值')
        self.cancel.clear()
        action, status = await self._action()
        if self.cancel.is_set():
            return result(False, error='CANCELLED', message='运动已停止')
        if action != LOCOMOTION or status != 100:
            return result(False, error='NOT_READY', message='请先进入稳定的四足行走状态')
        self.started, self.duration = time.monotonic(), duration
        self.stop_detail = None
        self.motion_active = True
        with self.state_lock:
            self.state['busy'] = True
        with self.velocity_lock:
            self.target, self.publishing = (forward, angular), True
        self._publish()
        try:
            while time.monotonic() - self.started < duration and not self.cancel.is_set():
                await asyncio.sleep(min(.02, duration))
            cancelled = self.cancel.is_set()
            detail = self.stop_detail or self._progress()
            return result(not cancelled, detail, 'CANCELLED' if cancelled else None, '运动已停止' if cancelled else None)
        finally:
            # deadline 取消同样先归零，避免残留目标速度。
            await self._zero()
            self.motion_active = False
            with self.state_lock:
                self.state['busy'] = False

    def _progress(self):
        elapsed = max(0, time.monotonic() - self.started)
        return {'elapsed_s': elapsed, 'completed_ratio': completed_ratio(elapsed, self.duration)}

    async def move(self, distance_m, speed_mps, duration_s):
        # 待真机验证: 速度与实际距离的比例由后端现场标定。
        return await self._velocity(speed_mps, 0.0, duration_s)

    async def turn(self, angle_deg, angular_speed, duration_s):
        # 待真机验证: angular_velocity 正值为逆时针，方向待真机确认。
        return await self._velocity(0.0, angular_speed, duration_s)

    async def _zero(self):
        if self.node is None:
            return
        with self.velocity_lock:
            self.target, self.publishing = (0.0, 0.0), True
        self._publish()
        # 重叠的 stop 共用发布窗口，旧调用不能提前关闭新窗口。
        self.zero_until = time.monotonic() + .3
        await asyncio.sleep(.3)
        with self.velocity_lock:
            if time.monotonic() >= self.zero_until:
                self.publishing = False

    async def stop(self):
        self.cancel.set()
        if self.motion_active:
            self.stop_detail = self.stop_detail or self._progress()
        detail = dict(self.stop_detail or {}) if self.motion_active else {}
        await self._zero()
        return result(detail=detail)

    async def speak(self, text, interrupt=False):
        # 依据 PlayTts.srv、PlayTtsRequest.msg、TtsPriorityLevel.msg、doc_PlayTts.md。
        req = self.types['PlayTts'].Request()
        req.header.header.stamp = self._stamp()
        tts = req.tts_req
        tts.text, tts.domain = text, 'moonstone'
        tts.trace_id = str(command_id.get() or uuid4())
        tts.priority_level.value = self.tts_priority.INTERACTION_L6
        tts.priority_weight, tts.is_interrupted = 0, interrupt
        response = await self._call('PlayTts', req)
        if not response.tts_resp.is_success:
            return result(False, {'sdk_message': response.tts_resp.error_message}, 'UPSTREAM_ERROR', '语音播报请求失败')
        # 待真机验证: 接口只确认入队，字数估时不代表实际播报完成。
        await asyncio.sleep(len(text) * .2)
        return result(detail={'estimated': True, 'duration_s': len(text) * .2, 'trace_id': tts.trace_id})

    async def led(self, mode):
        # 依据 LedStripCommand.srv / play_lights.py。
        allowed = {'ALL_OFF', 'GREEN_FLOW', 'RAINBOW', 'DANCING', 'TWINKLE', 'TAIL_INCREASE', 'TAIL_DECREASE',
                   'FOUR_TO_TWO_LEGS', 'TWO_TO_FOUR_LEGS', 'START_UP', 'DISPLAY_CHARGING', 'DISPLAY_FAULT'}
        if mode not in allowed:
            return result(False, error='INVALID_ARGS', message='灯光模式不在允许的白名单内')
        req = self.types['LedStripCommand'].Request()
        req.request.header.stamp = self._stamp()
        req.led_strip_mode = getattr(req, 'LED_' + mode)
        response = await self._call('LedStripCommand', req)
        return result() if response.header.header.code == 0 else result(False, error='UPSTREAM_ERROR', message='设置灯光失败')

    async def snapshot(self):
        # 依据 CaptureJpegImage.srv、JpegImage.msg、get_jpg.py。
        async with self.camera_lock:
            req = self.types['CaptureJpegImage'].Request()
            req.request.header.stamp = self._stamp()
            req.camera_id, req.timeout_ms = self.camera_id, 3000
            response = await self._call('CaptureJpegImage', req, timeout=4)
            if response.response.header.code != 0 or response.response.status.value != self.common_state.SUCCESS:
                return result(False, error='UPSTREAM_ERROR', message='相机采集失败')
            data = bytes(response.jpeg.image.data)
            if not data:
                return result(False, error='UPSTREAM_ERROR', message='相机返回空图像')
            # 待真机验证: 四足视角与图像朝向。
            return result(detail={'jpeg_b64': base64.b64encode(data).decode('ascii')})

    async def close(self):
        failure = None
        try:
            await self.stop()
            if self.poller:
                self.poller.cancel()
                await asyncio.gather(self.poller, return_exceptions=True)
                self.poller = None
            if self.registered:
                response = await self._input(1003)
                if response.response.header.code != 0:
                    failure = '删除机器人输入源失败'
        except Exception:
            failure = '释放机器人输入源失败'
        finally:
            self.registered = False
            if self.executor:
                await asyncio.to_thread(self.executor.shutdown)
            if self.thread:
                await asyncio.to_thread(self.thread.join)
            if self.node:
                self.node.destroy_node()
                self.node = None
            if self.switch_node:
                self.switch_node.destroy_node()
                self.switch_node = None
            if self.ros and self.ros.ok():
                self.ros.shutdown()
        return result(False, error='UPSTREAM_ERROR', message=failure) if failure else result()
