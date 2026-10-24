from enum import Enum
from time import time
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class DemoMode(str, Enum):
    OUTDOOR = 'outdoor'
    INDOOR = 'indoor'


class TaskStatus(str, Enum):
    QUEUED = 'QUEUED'
    RUNNING = 'RUNNING'
    DONE = 'DONE'
    FAILED = 'FAILED'
    CANCELLED = 'CANCELLED'


class Command(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class CmdResult(BaseModel):
    ok: bool
    detail: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    message: str | None = None


class RobotState(BaseModel):
    online: bool = False
    stale: bool = False
    backend: Literal['mock', 'bridge'] = 'mock'
    battery: int | None = None
    action: str = 'PASSIVE_DEFAULT'
    action_status: str = 'RUNNING'
    busy: bool = False
    current_command: str | None = None


class Task(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    steps: list[Command]
    current_step: int = 0
    status: TaskStatus = TaskStatus.QUEUED
    error: str | None = None
    message: str | None = None
    created_at: float = Field(default_factory=time)
    updated_at: float = Field(default_factory=time)
    step_started_at: float | None = None
    source: str = 'api'
    cancel_reason: str | None = None
    completed_ratio: float | None = None


class RobotEvent(BaseModel):
    type: str
    data: dict[str, Any]
    ts: float = Field(default_factory=time)


MIMIC_MOTIONS = {name: 'QUAD_MIMIC_' + name for name in ('GREET', 'HEED', 'GLANCE', 'HANDSHAKE', 'PONDER')}
POSTURES = {'stand', 'sit', 'lie_down'}
LED_MODES = dict(zip(('ALL_OFF', 'GREEN_FLOW', 'RAINBOW', 'DANCING', 'TWINKLE', 'TAIL_INCREASE', 'TAIL_DECREASE', 'FOUR_TO_TWO_LEGS', 'TWO_TO_FOUR_LEGS', 'START_UP', 'DISPLAY_CHARGING', 'DISPLAY_FAULT'), range(12)))
MOTION_COMMANDS = {'move', 'turn'}


class RouteStep(BaseModel):
    index: int
    instruction: str
    distance_m: float = 0
    action: Literal['straight', 'turn_left', 'turn_right', 'other'] = 'straight'
    end: tuple[float, float]
    robot_cmds: list[Command] = Field(default_factory=list)


class Route(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    route_id: str = Field(default_factory=lambda: 'r-' + str(uuid4()))
    mode: DemoMode
    distance_m: float = Field(0, ge=0)
    duration_s: float = Field(0, ge=0)
    coord: Literal['gcj02', 'local_m']
    polyline: list[tuple[float, float]] = Field(default_factory=list)
    steps: list[RouteStep] = Field(default_factory=list)
    robot_plan: list[Command] | None = None
    current_step: int = 0
    cached: bool = False
    destination_name: str = ''
    aliases: list[str] = Field(default_factory=list)
    sample: bool = False
    note: str = ''


class NavPlanRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', populate_by_name=True, allow_inf_nan=False)
    mode: DemoMode
    origin: tuple[float, float] | None = None
    origin_coord: Literal['wgs84', 'gcj02'] = 'gcj02'
    destination: str | tuple[float, float] | None = None
    from_id: str | None = Field(None, alias='from')
    to: str | None = None


class Intent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)


class AssistantReply(BaseModel):
    text: str
    intents: list[Intent] = Field(default_factory=list)
    executed: list[dict[str, Any]] = Field(default_factory=list)
    via: Literal['fast', 'llm', 'keywords']
