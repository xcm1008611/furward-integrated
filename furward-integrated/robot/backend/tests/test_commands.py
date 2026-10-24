import pytest
from pydantic import ValidationError
from app.config import Settings
from app.errors import ApiError
from app.models import Command, DemoMode
from app.services.commands import validate_command


@pytest.mark.parametrize('name,args', [
    ('move', {'distance_m': 0}), ('move', {'distance_m': -1}), ('move', {'distance_m': 3.01}),
    ('move', {'distance_m': True}), ('move', {'distance_m': '1'}), ('move', {'distance_m': float('nan')}),
    ('turn', {'angle_deg': 0}), ('turn', {'angle_deg': 181}), ('turn', {'angle_deg': -181}),
    ('turn', {'angle_deg': float('inf')}), ('speak', {'text': ''}), ('speak', {'text': '字' * 101}),
    ('speak', {'text': '你好', 'interrupt': 1}), ('posture', {'name': 'jump'}),
    ('mimic', {'motion': 'FLIP'}), ('led', {'mode': 1}), ('led', {'mode': []}),
    ('unknown', {}), ('move', {}), ('stand_up', {'unexpected': 1}),
])
def test_invalid(settings, name, args):
    cmd = Command(name=name, args=args)
    with pytest.raises(ApiError) as exc:
        validate_command(cmd, DemoMode.INDOOR, settings)
    assert exc.value.code == 'INVALID_ARGS'
    assert cmd.args == args


@pytest.mark.parametrize('name,args', [
    ('move', {'distance_m': 3}), ('turn', {'angle_deg': -180}), ('turn', {'angle_deg': 180}),
    ('speak', {'text': '字' * 100}), ('posture', {'name': 'lie_down'}),
    ('mimic', {'motion': 'GREET'}), ('led', {'mode': 'DISPLAY_FAULT'}), ('stop', {}),
])
def test_valid(settings, name, args):
    assert validate_command(Command(name=name, args=args), DemoMode.INDOOR, settings).name == name


@pytest.mark.parametrize('name,args', [('move', {'distance_m': 1}), ('turn', {'angle_deg': 90})])
def test_outdoor(settings, name, args):
    with pytest.raises(ApiError) as exc:
        validate_command(Command(name=name, args=args), DemoMode.OUTDOOR, settings)
    assert exc.value.code == 'MODE_FORBIDDEN'
    assert exc.value.message == '室外演示模式下机器狗不移动'


@pytest.mark.parametrize('field,value', [('linear_speed', 0.1), ('linear_speed', 0.5), ('angular_speed', 0), ('mock_time_scale', -1), ('cmd_deadline_s', float('inf'))])
def test_settings_limits(field, value):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: value})
