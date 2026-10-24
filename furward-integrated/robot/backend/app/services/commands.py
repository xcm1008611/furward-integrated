import math
from app.config import Settings
from app.errors import ApiError, INVALID_ARGS, MODE_FORBIDDEN
from app.models import Command, DemoMode, LED_MODES, MIMIC_MOTIONS, MOTION_COMMANDS, POSTURES


def validate_command(cmd: Command, mode: DemoMode, settings: Settings) -> Command:
    fields = {'stand_up': set(), 'posture': {'name'}, 'mimic': {'motion'}, 'move': {'distance_m'}, 'turn': {'angle_deg'}, 'stop': set(), 'speak': {'text', 'interrupt'}, 'led': {'mode'}}
    if cmd.name not in fields or set(cmd.args) - fields[cmd.name]:
        raise ApiError(INVALID_ARGS, '命令或参数名称不合法')
    if mode == DemoMode.OUTDOOR and cmd.name in MOTION_COMMANDS:
        raise ApiError(MODE_FORBIDDEN, '室外演示模式下机器狗不移动', 403)
    args = dict(cmd.args)
    required = fields[cmd.name] - {'interrupt'}
    if not required <= args.keys():
        raise ApiError(INVALID_ARGS, '缺少命令参数')
    if cmd.name in MOTION_COMMANDS:
        key = 'distance_m' if cmd.name == 'move' else 'angle_deg'
        value = args[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ApiError(INVALID_ARGS, '距离或角度必须是有限数值')
        limit = settings.max_move_m if cmd.name == 'move' else settings.max_turn_deg
        if value == 0 or abs(value) > limit or (cmd.name == 'move' and value < 0):
            raise ApiError(INVALID_ARGS, '距离或角度超出允许范围')
        args[key] = float(value)
    choices = {'posture': ('name', POSTURES), 'mimic': ('motion', MIMIC_MOTIONS), 'led': ('mode', LED_MODES)}
    if cmd.name in choices:
        key, values = choices[cmd.name]
        if not isinstance(args[key], str) or args[key] not in values:
            raise ApiError(INVALID_ARGS, '参数不在允许的白名单内')
    if cmd.name == 'speak':
        if not isinstance(args['text'], str) or not 1 <= len(args['text']) <= 100:
            raise ApiError(INVALID_ARGS, '播报文字长度必须为 1–100 字')
        if 'interrupt' in args and not isinstance(args['interrupt'], bool):
            raise ApiError(INVALID_ARGS, '打断标志必须是布尔值')
        args.setdefault('interrupt', False)
    return Command(name=cmd.name, args=args)


def estimate_duration(cmd: Command, settings: Settings) -> float:
    if cmd.name == 'move':
        duration = abs(cmd.args['distance_m']) / settings.linear_speed
    elif cmd.name == 'turn':
        duration = abs(math.radians(cmd.args['angle_deg'])) / settings.angular_speed
    elif cmd.name == 'speak':
        duration = len(cmd.args['text']) * 0.2
    else:
        duration = {'stand_up': 3.0, 'posture': 1.5, 'mimic': 4.0}.get(cmd.name, 0.0)
    if settings.robot_backend == 'bridge' and cmd.name in {'move', 'turn'}:
        duration /= settings.calib_linear_scale if cmd.name == 'move' else settings.calib_angular_scale
    return duration * (settings.mock_time_scale if settings.robot_backend == 'mock' else 1.0)


def with_auto_stand(commands: list[Command], action: str) -> list[Command]:
    result = []
    ready = action == 'QUADRUPED_LOCOMOTION_DEFAULT'
    for command in commands:
        if command.name in {'mimic', 'move', 'turn'} and not ready:
            result.append(Command(name='stand_up'))
            ready = True
        result.append(command)
        if command.name == 'stand_up':
            ready = True
        elif command.name == 'posture':
            ready = command.args['name'] == 'stand'
    return result
