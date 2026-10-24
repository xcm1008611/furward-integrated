from fastapi import APIRouter, Request
from app.models import Command
from app.services.commands import validate_command, with_auto_stand

router = APIRouter()


@router.get('/api/robot/state')
async def state(request: Request):
    return {'ok': True, 'data': await request.app.state.state_publisher.get_state()}


@router.post('/api/robot/command')
async def command(body: Command, request: Request):
    state = request.app.state
    cmd = validate_command(body, state.modes.mode, state.settings)
    commands = [cmd] if cmd.name == 'stop' else with_auto_stand([cmd], (await state.gateway.get_state()).action)
    task = await state.scheduler.submit(body.name, commands, 'api')
    return {'ok': True, 'data': task}


@router.post('/api/robot/stop')
async def stop(request: Request):
    return {'ok': True, 'data': await request.app.state.scheduler.stop('stop')}


@router.post('/api/robot/prepare')
async def prepare(request: Request):
    from app.services.sequences import prepare_sequence
    state = request.app.state
    robot = await state.gateway.get_state()
    commands = prepare_sequence(state.navigation.route, robot.action)
    task = await state.scheduler.submit('准备出发', commands, 'sequence')
    return {'ok': True, 'data': task}
