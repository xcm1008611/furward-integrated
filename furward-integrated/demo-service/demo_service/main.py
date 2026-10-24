from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable, Literal
from urllib.parse import urlsplit

from anyio import CancelScope
from fastapi import FastAPI, Header, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException

from .engine import HEARTBEAT_TIMEOUT, Config, DemoError, Registry, World
from .intents import handle_text

DEFAULT_WORLD = Path(__file__).resolve().parents[2] / 'shared' / 'route.json'


class ActionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['start', 'pause', 'resume', 'cancel', 'reset', 'obstacle', 'obstacle_bypass', 'obstacle_clear']


class TextRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=500)


def create_app(world_path: Path | None = None, config: Config | None = None,
               clock: Callable[[], float] = time.monotonic) -> FastAPI:
    config = config or Config()
    world_path = world_path or Path(os.environ.get('DEMO_WORLD_PATH', str(DEFAULT_WORLD)))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        registry = Registry(World.load(world_path), config, clock)
        app.state.registry = registry

        async def ticker():
            while True:
                await asyncio.sleep(config.tick_s)
                registry.tick()

        worker = asyncio.create_task(ticker()) if config.run_ticker else None
        try:
            yield
        finally:
            if worker:
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)
            registry.close()

    app = FastAPI(title='Furward independent city demo', version='1.0.0', lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)

    def same_origin(headers) -> bool:
        origin = headers.get('origin')
        if origin is None:
            return True  # CLI clients still require the session bearer token.
        try:
            parsed = urlsplit(origin)
            return (parsed.scheme in {'http', 'https'} and not parsed.username and not parsed.password
                    and not parsed.path and not parsed.query and not parsed.fragment
                    and parsed.netloc.lower() == headers.get('host', '').lower())
        except ValueError:
            return False

    @app.middleware('http')
    async def origin_guard(request: Request, call_next):
        if not same_origin(request.headers):
            return JSONResponse({'ok': False, 'error': 'ORIGIN_FORBIDDEN', 'message': '请从本站页面打开体验。'}, status_code=403)
        return await call_next(request)

    @app.exception_handler(DemoError)
    async def demo_error(request: Request, exc: DemoError):
        return JSONResponse({'ok': False, 'error': exc.code, 'message': exc.message}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse({'ok': False, 'error': 'INVALID_ARGS', 'message': '请求参数不合法。'}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse({'ok': False, 'error': 'NOT_FOUND' if exc.status_code == 404 else 'INVALID_ARGS',
                             'message': '请求路径不存在。' if exc.status_code == 404 else '请求不被允许。'}, status_code=exc.status_code)

    def authenticated(request: Request, session_id: str, authorization: str | None):
        scheme, _, token = (authorization or '').partition(' ')
        if scheme.lower() != 'bearer' or not token:
            raise DemoError('AUTH', '缺少会话凭据，请重新开始。', 401)
        registry: Registry = request.app.state.registry
        return registry, registry.authenticate(session_id, token)

    @app.get('/api/demo/health')
    async def health():
        return {'ok': True, 'data': {'service': 'furward-demo', 'mode': 'simulation'}}

    @app.get('/api/demo/world')
    async def world(request: Request):
        return {'ok': True, 'data': request.app.state.registry.world.payload}

    @app.post('/api/demo/sessions')
    async def create_session(request: Request):
        return {'ok': True, 'data': request.app.state.registry.create()}

    @app.get('/api/demo/sessions/{session_id}')
    async def session_state(session_id: str, request: Request, authorization: str | None = Header(default=None)):
        _, session = authenticated(request, session_id, authorization)
        return {'ok': True, 'data': session.snapshot()}

    @app.post('/api/demo/sessions/{session_id}/actions')
    async def action(session_id: str, body: ActionRequest, request: Request, authorization: str | None = Header(default=None)):
        registry, session = authenticated(request, session_id, authorization)
        return {'ok': True, 'data': registry.action(session, body.action)}

    @app.post('/api/demo/sessions/{session_id}/text')
    async def text(session_id: str, body: TextRequest, request: Request, authorization: str | None = Header(default=None)):
        registry, session = authenticated(request, session_id, authorization)
        return {'ok': True, 'data': handle_text(registry, session, body.text)}

    @app.websocket('/ws/demo')
    async def websocket(ws: WebSocket):
        await ws.accept()
        if not same_origin(ws.headers):
            await ws.close(code=1008)
            return
        registry: Registry = ws.app.state.registry
        session, queue, workers = None, None, []
        try:
            hello = await asyncio.wait_for(ws.receive_json(), config.auth_timeout_s)
            if (not isinstance(hello, dict) or not isinstance(hello.get('session_id'), str)
                    or not isinstance(hello.get('token'), str)):
                await ws.close(code=1008)
                return
            session = registry.authenticate(hello['session_id'], hello['token'])
            queue = registry.attach(session)

            async def sender():
                while True:
                    state = await queue.get()
                    if state is None:
                        await ws.close(code=1008, reason='Session expired')
                        return
                    if state is HEARTBEAT_TIMEOUT:
                        await ws.close(code=4000, reason='Heartbeat timeout')
                        return
                    await ws.send_json({'type': 'demo.state', 'data': state, 'ts': time.time()})

            async def receiver():
                while True:
                    remaining = max(0, session.subscribers.get(queue, registry.clock()) - registry.clock())
                    message = await asyncio.wait_for(ws.receive_json(), remaining)
                    if isinstance(message, dict) and message.get('type') == 'ping':
                        registry.heartbeat(session, queue)
                        await ws.send_json({'type': 'pong', 'data': {}, 'ts': time.time()})

            workers = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
            completed, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
            for worker in completed:
                worker.result()
        except (DemoError, asyncio.TimeoutError, ValueError, KeyError, TypeError) as exc:
            if ws.client_state.name == 'CONNECTED' and ws.application_state.name == 'CONNECTED':
                heartbeat_expired = (queue is not None and isinstance(exc, asyncio.TimeoutError)
                                     or isinstance(exc, DemoError) and exc.code == 'CONNECTION_TIMEOUT')
                await ws.close(code=4000 if heartbeat_expired else 1008)
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        finally:
            if session is not None and queue is not None:
                registry.detach(session, queue)
            for worker in workers:
                worker.cancel()
            if workers:
                # Starlette cancels the ASGI scope as a socket disconnects. Finish
                # both owned tasks before returning, even under that cancellation.
                with CancelScope(shield=True):
                    await asyncio.gather(*workers, return_exceptions=True)

    return app


app = create_app()
