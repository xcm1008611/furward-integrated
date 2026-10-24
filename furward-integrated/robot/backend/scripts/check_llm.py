"""现场验证：从 backend 目录执行 ../.venv/bin/python scripts/check_llm.py。"""
import asyncio
import sys
from pathlib import Path
from time import monotonic

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings
from app.robot.mock import MockRobot
from app.services.llm import LLMClient, LLMError


async def main():
    settings = Settings(_env_file=Path(__file__).resolve().parents[1] / '.env')
    llm = LLMClient(settings)
    print(f'模型：{settings.deepseek_model}')
    if not llm.available:
        print('请在 backend/.env 配置 DEEPSEEK_API_KEY 并启用 LLM_ENABLED')
        return 1
    failed = False
    try:
        for kind in ('纯文本', '测试图片'):
            start = monotonic()
            try:
                if kind == '纯文本':
                    response = await llm._request([{'role': 'user', 'content': '请用一句中文介绍自己。'}], settings.llm_timeout_s)
                    content = response.choices[0].message.content
                else:
                    jpeg = await MockRobot(settings).snapshot()
                    content = await llm.describe_image(jpeg, '这是现场生成的测试图片')
                print(f'{kind}：{monotonic()-start:.2f} 秒；返回：{content}')
            except LLMError as exc:
                failed = True
                print(f'{kind}：{monotonic()-start:.2f} 秒；失败：{exc}；超时：{exc.is_timeout}')
    finally:
        await llm.close()
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
