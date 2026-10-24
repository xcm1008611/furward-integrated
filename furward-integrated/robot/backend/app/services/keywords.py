import re
import unicodedata

from app.models import Intent


def normalize(text: str) -> str:
    return ''.join(c for c in text.lower() if not c.isspace() and not unicodedata.category(c).startswith('P'))


CANCEL_WORDS = ('取消导航', '结束导航', '停止导航', '退出导航', '关闭导航', '导航结束', '不去了', '不走了', '别去了', '不用去了')


def parse_fast_path(text: str) -> Intent | None:
    text = normalize(text)
    # 结束导航不能依赖大模型：说法里常带“停”，被误判成暂停就永远结束不了。
    # 同一句里还要去别处时交给逐句解析，避免吞掉后半句。
    if any(word in text for word in CANCEL_WORDS) and not re.search(r'带我去|我要去|怎么走', text):
        return Intent(tool='nav_cancel')
    for words, tool in [(('停一下', '等一下', '等等', '暂停'), 'nav_pause'),
                        (('继续', '接着走', '走吧', '出发吧'), 'nav_resume')]:
        if any(word in text for word in words):
            return Intent(tool=tool)
    if text.strip('啊吧呀了') in {'停', '停下', '别动', '站住', 'stop'}:
        return Intent(tool='robot_stop')
    return None


def number(text: str) -> float:
    digits = dict(zip('零一二三四五六七八九', range(10)))
    text = text.replace('两', '二')
    if text == '半':
        return 0.5
    if '点' in text:
        whole, fraction = text.split('点', 1)
        if not whole or not fraction:
            raise ValueError('数量不完整')
        return number(whole) + float('0.' + ''.join(str(digits[c]) for c in fraction))
    if '十' in text:
        tens, ones = text.split('十')
        return (digits[tens] if tens else 1) * 10 + (digits[ones] if ones else 0)
    if text in digits:
        return float(digits[text])
    return float(text)


def parse_keywords(text: str, waypoint_names) -> list[Intent]:
    # 数值的小数点必须保留，不能使用快速通道的标点归一化。
    text = re.sub(r'\s+', '', text)
    results = []
    for part in re.split(r'[，,。；;！!？?]|然后|接着|再(?=带我去|我要去|前进|往前走|左转|右转|站起|坐下|打招呼)', text):
        part = re.sub(r'^先', '', part)
        if not part:
            continue
        fast = parse_fast_path(part)
        if fast:
            results.append(fast)
            continue
        destination = re.search(r'(?:带我去|我要去)(.+)|去(.+?)怎么走', part)
        if destination:
            name = destination.group(1) or destination.group(2)
            if name not in waypoint_names:
                name = name.strip('啊吧呀')
            results.append(Intent(tool='nav_go', args={'destination': name}))
            continue
        move = re.search(r'(前进|往前走|左转|右转)([+-]?\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万半点]+)?(米|步|度|°)?', part)
        if move:
            action, amount, unit = move.groups()
            is_move = action in {'前进', '往前走'}
            try:
                value = number(amount) if amount else (1.0 if is_move else 90.0)
            except (ValueError, KeyError):
                # 不认识的数量交给统一参数校验拒绝，不能截取成小距离后执行。
                results.append(Intent(tool='robot_move' if is_move else 'robot_turn', args={
                    'distance_m' if is_move else 'angle_deg': amount}))
                continue
            if is_move and unit == '步':
                value *= 0.5
            results.append(Intent(tool='robot_move' if is_move else 'robot_turn', args={
                'distance_m' if is_move else 'angle_deg': -value if action == '右转' else value}))
            continue
        for words, tool, args in [
            (('站起', '起来'), 'robot_stand_up', {}),
            (('坐下',), 'robot_posture', {'name': 'sit'}),
            (('趴下',), 'robot_posture', {'name': 'lie_down'}),
            (('打招呼', '问好', '打个招呼', '你好', '嗨'), 'robot_mimic', {'motion': 'GREET'}),
            (('握手',), 'robot_mimic', {'motion': 'HANDSHAKE'}),
            (('下一步',), 'nav_next', {}),
            (('再说一遍', '重复'), 'nav_repeat', {}),
            (('准备出发', '准备一下'), 'robot_prepare', {}),
            (('电量', '状态', '你在干嘛', '多少电', '电池', '电还够吗'), 'get_status', {}),
            (('前面有什么', '我前面是什么', '看看前面'), 'describe_scene', {}),
        ]:
            if any(word in part for word in words):
                results.append(Intent(tool=tool, args=args))
                break
    return results
