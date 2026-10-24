import shutil
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings

EXAMPLE = Path(__file__).resolve().parents[1] / '.env.example'


def test_env_example_loads_from_file(tmp_path):
    # .env 里的值都是字符串，回归测试 FRAME_ROTATE=0 曾导致启动失败。
    env = tmp_path / '.env'
    shutil.copy(EXAMPLE, env)
    settings = Settings(_env_file=env)
    assert settings.frame_rotate == 0


@pytest.mark.parametrize('value, expected', [('90', 90), ('180', 180), ('270', 270)])
def test_frame_rotate_from_env_file(tmp_path, value, expected):
    env = tmp_path / '.env'
    env.write_text(f'FRAME_ROTATE={value}\n', encoding='utf-8')
    assert Settings(_env_file=env).frame_rotate == expected


def test_frame_rotate_rejects_other_angles(tmp_path):
    env = tmp_path / '.env'
    env.write_text('FRAME_ROTATE=45\n', encoding='utf-8')
    with pytest.raises(ValidationError):
        Settings(_env_file=env)
