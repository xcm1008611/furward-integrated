import asyncio
import json
from collections import deque
from dataclasses import dataclass
from typing import Callable, Literal

from fastapi.encoders import jsonable_encoder
from pydantic import ConfigDict, ValidationError, create_model

from app.errors import ApiError, CANCELLED, INVALID_ARGS, UPSTREAM_ERROR
from app.models import AssistantReply, Command, DemoMode, Intent, NavPlanRequest, TaskStatus
from app.services.commands import validate_command, with_auto_stand
from app.services.keywords import parse_fast_path, parse_keywords
from app.services.sequences import prepare_sequence


@dataclass
class ToolSpec:
    description: str
    fields: dict
    reply: str
    handler: str
    operation: str = ''


# 定义、参数校验和执行器共用白名单，模型不能访问任意服务方法。
TOOL_TABLE = {
    'robot_stand_up': ToolSpec('站起', {}, '已经站起来了', '_robot', 'stand_up'),
    'robot_posture': ToolSpec('切换姿态', {'name': (Literal['stand', 'sit', 'lie_down'], ...)}, '姿态已调整', '_robot', 'posture'),
    'robot_mimic': ToolSpec('互动动作：GREET 打招呼、HEED 聆听、GLANCE 四处看、HANDSHAKE 握手、PONDER 思考', {'motion': (Literal['GREET', 'HEED', 'GLANCE', 'HANDSHAKE', 'PONDER'], ...)}, '好的，开始互动', '_robot', 'mimic'),
    'robot_move': ToolSpec('仅室内：向前走指定米数', {'distance_m': (float, ...)}, '好的，开始前进', '_robot', 'move'),
    'robot_turn': ToolSpec('仅室内：原地转向，单位度，左转为正、右转为负', {'angle_deg': (float, ...)}, '好的，开始转向', '_robot', 'turn'),
    'robot_stop': ToolSpec('立即停止', {}, '已停下', '_stop'),
    'robot_speak': ToolSpec('播报文字', {'text': (str, ...)}, '好的', '_robot', 'speak'),
    'robot_led': ToolSpec('灯光模式', {'mode': (str, ...)}, '灯光已调整', '_robot', 'led'),
    'robot_prepare': ToolSpec('原地做出发前准备动作（站起、打招呼、播报路线）', {}, '准备好了', '_prepare'),
    'nav_go': ToolSpec('带用户去某地。室内：目的地是室内航点名，机器狗会走过去；'
                       '室外：目的地是任意真实地名，在地图上规划步行路线并原地做准备动作（不移动）',
                       {'destination': (str, ...)}, '', '_plan', 'go'),
    'nav_plan': ToolSpec('只规划路线不出发，用于"怎么走""有多远"之类的问路', {'destination': (str, ...)}, '', '_plan', 'plan'),
    'nav_next': ToolSpec('下一步', {}, '已切换到下一步', '_navigation', 'next'),
    'nav_repeat': ToolSpec('重复当前路线步骤', {}, '', '_navigation', 'repeat'),
    'nav_execute': ToolSpec('执行室内路线', {}, '开始出发', '_navigation', 'execute'),
    'nav_pause': ToolSpec('暂停导航', {}, '好的，我先停一下，说"继续"就出发', '_navigation', 'pause'),
    'nav_resume': ToolSpec('继续导航', {}, '继续出发', '_navigation', 'resume'),
    'nav_cancel': ToolSpec('结束并取消当前导航（"结束导航""不去了""不走了"都用它；只想暂时停下才用 nav_pause）', {}, '好的，导航已结束', '_navigation', 'cancel'),
    'get_status': ToolSpec('查询电量、动作与导航状态', {}, '', '_status'),
    'describe_scene': ToolSpec('描述相机画面', {}, '', '_scene'),
}
PARAMS = {name: create_model(name + '_args', __config__=ConfigDict(extra='forbid', strict=True, allow_inf_nan=False), **spec.fields)
          for name, spec in TOOL_TABLE.items()}
# 回复文字本身会被播报；暴露 robot_speak 会让模型用它代替回复，造成重复播报。
LLM_HIDDEN_TOOLS = {'robot_speak'}
TOOLS = [{'type': 'function', 'function': {'name': name, 'description': spec.description,
          'parameters': PARAMS[name].model_json_schema()}} for name, spec in TOOL_TABLE.items()
         if name not in LLM_HIDDEN_TOOLS]


class Assistant:
    def __init__(self, settings, gateway, scheduler, modes, navigation, bus, llm,
                 obstacle_hints: Callable[[], str] | None = None, snapshot_fallback=None):
        self.settings, self.gateway, self.scheduler = settings, gateway, scheduler
        self.modes, self.navigation, self.bus, self.llm = modes, navigation, bus, llm
        self.obstacle_hints = obstacle_hints
        self.snapshot_fallback = snapshot_fallback
        self.history = deque(maxlen=settings.assistant_history_turns)
        self._event_ids = deque(maxlen=50)
        self._tasks = set()
        self._revision = 0

    def background(self, coroutine):
        started = False

        async def guarded():
            nonlocal started
            started = True
            try:
                await coroutine
            except Exception:
                await self.bus.log('error', '助手后台任务失败')
        task = asyncio.create_task(guarded())
        self._tasks.add(task)
        def finished(done):
            self._tasks.discard(done)
            if not started:
                coroutine.close()
        task.add_done_callback(finished)
        return task

    async def close(self):
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _speak(self, text):
        # TTS 与运动独立，不占用调度器；长组合回复分段播报。
        for offset in range(0, len(text), 100):
            result = await self.gateway.speak(text[offset:offset + 100])
            if not result.ok:
                await self.bus.log('error', result.message or '播报失败')
                break

    async def _messages(self, text):
        state = await self.gateway.get_state()
        route = self.navigation.route
        summary = {'目的地': route.destination_name, '路程米': route.distance_m,
                   '当前步骤': self.navigation.current_step} if route else None
        if self.modes.mode == DemoMode.OUTDOOR:
            mode_rule = ('当前是室外模式：机器狗原地不动，禁止robot_move、robot_turn、nav_execute。'
                         '用户问路或要去某地时（目的地可以是任意真实地名，如"张江科学会堂"），'
                         '必须调用nav_go或nav_plan在地图上规划步行路线，这是室外模式的主要功能，不要拒绝。')
        else:
            mode_rule = (f'当前是室内模式：机器狗会真实行走。nav_go的目的地只能是室内航点：{self.waypoint_names}；'
                         '不在列表里就告诉用户可去的航点。')
        prompt = ('你是导盲机器狗的语音助手，负责把用户的话变成工具调用。' + mode_rule +
                  f'机器人状态：{state.model_dump_json()}。导航状态：{self.navigation.status}；路线摘要：{json.dumps(summary, ensure_ascii=False)}。'
                  f'单段移动不得超过{self.settings.max_move_m}米，单次转向不得超过{self.settings.max_turn_deg}度，超限必须拒绝。'
                  '一句话包含多个动作时（如"先打招呼再带我去门口"），按顺序在同一次回复中调用多个工具。'
                  '动作必须调用工具，不得声称执行了未调用的工具。'
                  '你的回复文字会自动由机器狗播报，不需要也不能用工具播报；回复用简短中文口语，不超过50字。')
        messages = [{'role': 'system', 'content': prompt}]
        for user, reply in self.history:
            messages.extend([{'role': 'user', 'content': user}, {'role': 'assistant', 'content': reply}])
        return messages + [{'role': 'user', 'content': text}]

    @property
    def waypoint_names(self):
        return [w['name'] for w in self.navigation.indoor_map.waypoints.values()]

    async def handle_text(self, text, source, event_id=None) -> AssistantReply | None:
        if source not in {'robot', 'app', 'text'} or not isinstance(text, str) or not text.strip():
            raise ApiError(INVALID_ARGS, '请输入有效的文字和来源')
        if event_id is not None:
            if event_id in self._event_ids:
                return None
            self._event_ids.append(event_id)
        await self.bus.publish('voice.heard', {'text': text, 'source': source})
        await self.bus.log('heard', text, source=source)
        fast = parse_fast_path(text)
        via, content = 'fast' if fast else 'keywords', ''
        intents = [fast] if fast else []
        if fast and fast.tool in {'robot_stop', 'nav_pause'}:
            self._revision += 1
        revision = self._revision
        if not fast and self.llm.available:
            try:
                result = await asyncio.wait_for(self.llm.chat_tools(await self._messages(text), TOOLS), self.settings.llm_timeout_s)
                intents = [Intent(tool=call.name, args=call.args) for call in result.tool_calls]
                via, content = 'llm', (result.content or '')[:50]
            except Exception:
                await self.bus.log('error', '语言模型超时或请求失败，使用关键词解析')
        if via == 'keywords':
            intents = parse_keywords(text, self.waypoint_names)
        await self.bus.log('understood', text, via=via, intents=[i.model_dump() for i in intents])
        executed, replies = [], []
        for intent in intents:
            try:
                if revision != self._revision:
                    raise ApiError(CANCELLED, '已停止，先前的指令不再执行')
                if intent.tool not in TOOL_TABLE:
                    raise ApiError(INVALID_ARGS, '不支持这个助手工具')
                spec = TOOL_TABLE[intent.tool]
                try:
                    args = PARAMS[intent.tool].model_validate(intent.args).model_dump()
                except ValidationError as exc:
                    raise ApiError(INVALID_ARGS, '工具参数不合法') from exc
                result, reply = await getattr(self, spec.handler)(spec, args)
                record = {'tool': intent.tool, 'ok': True, 'data': jsonable_encoder(result)}
                replies.append(reply or spec.reply)
            except ApiError as exc:
                record = {'tool': intent.tool, 'ok': False, 'error': exc.code, 'message': exc.message}
                replies.append(exc.message)
            except Exception:
                record = {'tool': intent.tool, 'ok': False, 'error': UPSTREAM_ERROR, 'message': '工具执行失败，请稍后重试'}
                replies.append(record['message'])
                await self.bus.log('error', record['message'], tool=intent.tool)
            executed.append(record)
            await self.bus.log('executed', replies[-1], **record)
            if not record['ok']:
                break
        reply_text = '；'.join(filter(None, replies)) if intents else content
        reply_text = reply_text or '我没听懂，可以说"带我去服务台""停一下""继续"'
        reply = AssistantReply(text=reply_text, intents=intents, executed=executed, via=via)
        self.history.append((text, reply_text))
        await self.bus.publish('assistant.reply', {'text': reply.text, 'via': via, 'intents': [i.model_dump() for i in intents]})
        self.background(self._speak(reply.text))
        return reply

    async def _submit(self, name, commands):
        task = await self.scheduler.submit(name, commands, 'assistant')
        task = await self.scheduler.wait(task.id)
        if task.status != TaskStatus.DONE:
            raise ApiError(task.error or UPSTREAM_ERROR, task.message or '机器人动作失败')
        return task

    async def _robot(self, spec, args):
        cmd = validate_command(Command(name=spec.operation, args=args), self.modes.mode, self.settings)
        if cmd.name == 'speak':
            # 工具播报同样绕开运动调度，实际文字作为最终回复统一后台播报。
            return {'accepted': True}, args['text']
        commands = with_auto_stand([cmd], (await self.gateway.get_state()).action)
        reply = spec.reply
        if cmd.name == 'move':
            reply = f'好的，往前走 {args["distance_m"]:g} 米'
        elif cmd.name == 'turn':
            angle = args['angle_deg']
            reply = f'好的，{"左" if angle > 0 else "右"}转 {abs(angle):g} 度'
        elif cmd.name == 'mimic' and args['motion'] == 'GREET':
            reply = '你好！'
        return await self._submit(spec.description, commands), reply

    async def _stop(self, spec, args):
        self._revision += 1
        return await self.scheduler.stop(), spec.reply

    async def _prepare(self, spec, args):
        state = await self.gateway.get_state()
        return await self._submit('准备出发', prepare_sequence(self.navigation.route, state.action)), spec.reply

    async def _plan(self, spec, args):
        destination = args['destination']
        if not destination.strip():
            raise ApiError(INVALID_ARGS, '请指定目的地')
        mode = self.modes.mode
        route = await self.navigation.plan(NavPlanRequest(mode=mode, to=destination if mode == DemoMode.INDOOR else None,
                                                         destination=destination))
        if spec.operation == 'go':
            if mode == DemoMode.INDOOR:
                await self.navigation.execute()
                return route, f'好的，带你去{route.destination_name}，全程约 {route.distance_m:g} 米'
            await self._prepare(TOOL_TABLE['robot_prepare'], {})
            return route, '室外演示我不移动，路线已经显示在手机上'
        return route, f'路线已规划，到{route.destination_name}全程约 {route.distance_m:g} 米'

    async def _navigation(self, spec, args):
        if spec.operation == 'cancel':
            self._revision += 1
        result = await getattr(self.navigation, spec.operation)(**args)
        route = self.navigation.route
        reply = spec.reply
        if spec.operation in {'next', 'repeat'} and route:
            reply = route.steps[self.navigation.current_step].instruction if self.navigation.current_step < len(route.steps) else f'已到达{route.destination_name}'
        return result, reply

    async def _status(self, spec, args):
        state = await self.gateway.get_state()
        task = self.scheduler.current()
        action = '待命'
        if self.scheduler.busy and task:
            action = {'move': '前进', 'turn': '转向', 'stand_up': '站起', 'posture': '调整姿态', 'mimic': '互动', 'speak': '播报', 'led': '调整灯光'}.get(task.steps[task.current_step].name, '执行任务')
        nav = {'IDLE': '未出发', 'ACTIVE': '导航中', 'PAUSED': '已暂停', 'DONE': '已到达', 'CANCELLED': '已取消', 'FAILED': '导航失败'}[self.navigation.status]
        battery = f'{state.battery}%' if state.battery is not None else '未知'
        return state, f'电量{battery}，正在{action}，导航{nav}'

    async def _scene(self, spec, args):
        hints = ''
        try:
            hints = self.obstacle_hints() if self.obstacle_hints else ''
        except Exception:
            await self.bus.log('error', '读取障碍提示失败')
        try:
            async def describe():
                jpeg = await self.gateway.snapshot()
                if jpeg is None and self.snapshot_fallback:
                    jpeg = await self.snapshot_fallback()
                if jpeg and self.llm.available:
                    return await self.llm.describe_image(jpeg, hints)
                return None
            text = await asyncio.wait_for(describe(), self.settings.vision_timeout_s)
        except Exception:
            await self.bus.log('error', '看图描述失败，使用检测提示')
            text = None
        text = text or (hints if hints == '前方暂时没有检测到障碍物' else
                        f'{hints}。请注意安全' if hints else '我现在看不清前面，请注意安全')
        return {'text': text}, text
