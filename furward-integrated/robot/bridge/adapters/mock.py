import asyncio
import time

from .base import BaseAdapter, result

LOCOMOTION = 'QUADRUPED_LOCOMOTION_DEFAULT'


class MockAdapter(BaseAdapter):
    def __init__(self):
        self.state = {'battery': 90, 'action': 'PASSIVE_DEFAULT', 'action_status': 'RUNNING', 'busy': False}
        self.cancel = None
        self.started = 0
        self.duration = 0
        self.stop_detail = None

    async def start(self):
        return result()

    async def close(self):
        await self.stop()
        return result()

    async def get_state(self):
        return result(detail=dict(self.state))

    async def stand_up(self):
        return await self.posture('stand')

    async def posture(self, name):
        action = {'stand': LOCOMOTION, 'sit': 'QUADRUPED_SIT_DOWN_DEFAULT', 'lie_down': 'QUADRUPED_GET_DOWN_DEFAULT'}[name]
        outcome = await self._wait(.05)
        if outcome['ok']:
            self.state['action'] = action
        return outcome

    async def mimic(self, motion):
        return await self._wait(.1)

    async def _wait(self, duration):
        self.started, self.duration = time.monotonic(), duration
        self.cancel = asyncio.Event()
        self.stop_detail = None
        self.state['busy'] = True
        try:
            try:
                await asyncio.wait_for(self.cancel.wait(), duration)
            except asyncio.TimeoutError:
                return result(detail={'duration_s': duration})
            return result(False, self.stop_detail, 'CANCELLED', '动作已停止')
        finally:
            self.state['busy'] = False
            self.cancel = None

    async def move(self, distance_m, speed_mps, duration_s):
        return await self._wait(duration_s)

    async def turn(self, angle_deg, angular_speed, duration_s):
        return await self._wait(duration_s)

    async def stop(self):
        detail = {}
        if self.cancel:
            elapsed = max(0, time.monotonic() - self.started)
            self.stop_detail = self.stop_detail or {'elapsed_s': elapsed,
                'completed_ratio': min(1, elapsed / self.duration) if self.duration else 1}
            detail = self.stop_detail
            self.cancel.set()
        return result(detail=detail)

    async def speak(self, text, interrupt=False):
        await asyncio.sleep(.01)
        return result(detail={'estimated': True})

    async def led(self, mode):
        return result()

    async def snapshot(self):
        return result(False, error='NOT_SUPPORTED', message='桥接模拟器不提供相机画面')
