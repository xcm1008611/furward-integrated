import math
from app.models import Command, Route


def prepare_sequence(route: Route | None, action: str | None = None) -> list[Command]:
    commands = [] if action == 'QUADRUPED_LOCOMOTION_DEFAULT' else [Command(name='stand_up')]
    if route:
        text = f'路线已规划，全程约 {route.distance_m:.0f} 米，步行约 {max(1, math.ceil(route.duration_s / 60))} 分钟。'
        if route.steps:
            text += '第一步，' + route.steps[0].instruction
        text = text[:100]
    else:
        text = '我准备好了，请告诉我要去哪里'
    return commands + [Command(name='led', args={'mode': 'GREEN_FLOW'}), Command(name='mimic', args={'motion': 'GREET'}), Command(name='speak', args={'text': text}), Command(name='mimic', args={'motion': 'HEED'})]
