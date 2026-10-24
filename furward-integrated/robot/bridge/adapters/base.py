from abc import ABC, abstractmethod
from contextvars import ContextVar

command_id = ContextVar('command_id', default=None)


def result(ok=True, detail=None, error=None, message=None):
    return {'ok': ok, 'detail': detail or {}, 'error': error, 'message': message}


class BaseAdapter(ABC):
    def set_asr_handler(self, cb):
        self.asr_handler = cb

    @abstractmethod
    async def start(self): ...

    @abstractmethod
    async def close(self): ...

    @abstractmethod
    async def get_state(self): ...

    @abstractmethod
    async def stand_up(self): ...

    @abstractmethod
    async def posture(self, name): ...

    @abstractmethod
    async def mimic(self, motion): ...

    @abstractmethod
    async def move(self, distance_m, speed_mps, duration_s): ...

    @abstractmethod
    async def turn(self, angle_deg, angular_speed, duration_s): ...

    @abstractmethod
    async def stop(self): ...

    @abstractmethod
    async def speak(self, text, interrupt=False): ...

    @abstractmethod
    async def led(self, mode): ...

    @abstractmethod
    async def snapshot(self): ...
