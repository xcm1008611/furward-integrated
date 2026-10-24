from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from fastapi.responses import JSONResponse

MODE_FORBIDDEN = 'MODE_FORBIDDEN'
ROBOT_BUSY = 'ROBOT_BUSY'
ROBOT_OFFLINE = 'ROBOT_OFFLINE'
INVALID_ARGS = 'INVALID_ARGS'
TIMEOUT = 'TIMEOUT'
CANCELLED = 'CANCELLED'
NOT_FOUND = 'NOT_FOUND'
NO_ROUTE = 'NO_ROUTE'
UPSTREAM_ERROR = 'UPSTREAM_ERROR'
NOT_SUPPORTED = 'NOT_SUPPORTED'
AUTH = 'AUTH'
ACTION_SWITCH_FAILED = 'ACTION_SWITCH_FAILED'
NOT_READY = 'NOT_READY'
MOCK_FAIL = 'MOCK_FAIL'
INTERNAL_ERROR = 'INTERNAL_ERROR'


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def install_handlers(app: FastAPI):
    async def api_error(request: Request, exc: ApiError):
        return JSONResponse({'ok': False, 'error': exc.code, 'message': exc.message}, status_code=exc.status)

    async def validation_error(request: Request, exc: RequestValidationError):
        return await api_error(request, ApiError(INVALID_ARGS, '请求参数不合法', 422))

    async def http_error(request: Request, exc: HTTPException):
        return await api_error(request, ApiError(NOT_FOUND if exc.status_code == 404 else INVALID_ARGS, '请求路径不存在' if exc.status_code == 404 else '请求不被允许', exc.status_code))

    async def unexpected_error(request: Request, exc: Exception):
        return await api_error(request, ApiError(INTERNAL_ERROR, '服务内部错误', 500))

    app.add_exception_handler(ApiError, api_error)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_exception_handler(HTTPException, http_error)
    app.add_exception_handler(Exception, unexpected_error)
