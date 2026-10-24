from fastapi import APIRouter, Request

router = APIRouter()


@router.get('/api/tasks/current')
async def current(request: Request):
    return {'ok': True, 'data': request.app.state.scheduler.current()}
