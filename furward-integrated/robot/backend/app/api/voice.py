from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, ConfigDict, Field

from app.errors import ApiError, NOT_SUPPORTED

router = APIRouter()


class TextRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    text: str = Field(min_length=1)


@router.post('/api/voice/text')
async def text(body: TextRequest, request: Request):
    return {'ok': True, 'data': await request.app.state.assistant.handle_text(body.text, 'text')}


@router.post('/api/voice/audio', openapi_extra={'requestBody': {'content': {
    'multipart/form-data': {'schema': {'type': 'object', 'properties': {
        'file': {'type': 'string', 'format': 'binary'}}}}}}})
async def audio(request: Request, file: bytes = Body(default=b'', media_type='multipart/form-data')):
    # 占位接口不解析表单，避免依赖当前环境未安装的 python-multipart。
    raise ApiError(NOT_SUPPORTED, '手机录音识别尚未接入，请使用机器狗麦克风或文字输入')
