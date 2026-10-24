"""Reuse the robot keywords' normalization and stop/cancel precedence, without its runtime.

The whitelist intentionally maps only to this session's simulation actions.
"""
import re
import unicodedata

from .engine import Registry, Session

CANCEL_WORDS = ('取消导航', '结束导航', '停止导航', '退出导航', '关闭导航', '导航结束', '不去了', '不走了', '别去了', '不用去了')


def normalize(text: str) -> str:
    return ''.join(c for c in text.lower() if not c.isspace() and not unicodedata.category(c).startswith('P'))


def handle_text(registry: Registry, session: Session, text: str) -> dict:
    normalized = normalize(text)
    action = None
    # End-navigation expressions are checked before the broader pause/stop words.
    if any(word in normalized for word in CANCEL_WORDS):
        action = 'cancel'
    elif (any(word in normalized for word in ('停一下', '等一下', '等等', '暂停'))
          or normalized.strip('啊吧呀了') in {'停', '停下', '别动', '站住', 'stop'}):
        action = 'pause'
    elif any(word in normalized for word in ('绕行', '绕过', '绕过去', '避开障碍', '移开障碍', '清除障碍', '清障', '障碍清除', '障碍已移开')):
        action = 'obstacle_bypass'
    elif any(word in normalized for word in ('模拟障碍', '添加障碍', '遇到障碍')):
        action = 'obstacle'
    elif any(word in normalized for word in ('重新体验', '回到起点', '重新开始')):
        action = 'reset'
    elif any(word in normalized for word in ('继续', '接着走', '走吧', '出发吧')):
        action = 'start' if session.status == 'IDLE' else 'resume'
    elif any(word in normalized for word in ('开始出发', '开始导航', '准备出发', '开始体验')):
        action = 'start'
    else:
        destination = re.search(r'(?:带我去|我要去)(.+)|去(.+?)怎么走', normalized)
        if destination:
            name = (destination.group(1) or destination.group(2)).strip('啊吧呀')
            if name in {registry.world.payload['route']['destination_name'], '演示路线', '演示城市', '城市演示'}:
                if session.status in {'DONE', 'CANCELLED'}:
                    registry.action(session, 'reset')
                action = 'resume' if session.status == 'PAUSED' else 'start'
            else:
                return {'reply': '当前演示路线可以前往街心花园。', 'state': session.snapshot()}
    if action:
        state = registry.action(session, action)
        return {'reply': state['message'], 'state': state}
    if any(word in normalized for word in ('重复', '再说一遍', '下一步', '状态', '走到哪')):
        reply = session.message
    elif any(word in normalized for word in ('前面有什么', '看看前面')):
        if session.obstacle_active:
            reply = '演示道路前方有障碍，可以说“绕行”让绒途带你从旁边通过。'
        elif session.detour_until_m is not None:
            reply = '正在绕过前方的障碍，障碍保留原位。'
        else:
            reply = '演示道路前方暂时没有障碍。'
    else:
        reply = '可以说“带我去街心花园”“停一下”“绕行”“继续”或“结束导航”。'
    return {'reply': reply, 'state': session.snapshot()}

