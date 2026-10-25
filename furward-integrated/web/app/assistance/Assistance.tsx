'use client';

/* eslint-disable react-hooks/set-state-in-effect -- Hydrate browser speech capabilities and announce external navigation transitions after mount. */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Mic, MicOff, Pause, Play, RotateCcw, Square, Send, Volume2, VolumeX, MapPin, Eye, Repeat, Construction, Gauge, Milestone, Maximize2, Minimize2, Vibrate } from 'lucide-react';
import { useDemoSession } from '@/lib/demo-session';
import { navigationForState, STATUS_LABELS, type DemoAction, type DemoState, type DemoWorld } from '@/lib/demo-types';
import RouteMap from '../experience/RouteMap';
import { createSpeechPlayer } from '../experience/speech';
import { hapticsSupported, setHapticsEnabled, vibrate } from './haptics';
import { useVoiceInput } from './voice';
import styles from './assistance.module.css';

type LogLine = { id: number; who: '你' | '绒途'; text: string };

const QUICK_PHRASES = ['带我去街心花园', '停一下', '继续', '前面有什么', '绕行', '再说一遍', '结束导航'];

const RATES = [{ key: 'slow', label: '慢', value: 0.75 }, { key: 'normal', label: '正常', value: 0.95 }, { key: 'fast', label: '快', value: 1.25 }] as const;
type RateKey = typeof RATES[number]['key'];
type Settings = { rate: RateKey; progress: boolean; focus: boolean; vibration: boolean };
const SETTINGS_KEY = 'furward-assistance-settings';
/** Spoken distance updates every this many metres while walking. */
const PROGRESS_STEP_M = 25;

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    const focus = new URLSearchParams(location.search).get('focus');
    return { rate: RATES.some(rate => rate.key === saved.rate) ? saved.rate as RateKey : 'normal', progress: saved.progress ?? true,
      focus: focus === null ? saved.focus ?? false : focus !== '0', vibration: saved.vibration ?? true };
  } catch {
    return { rate: 'normal', progress: true, focus: false, vibration: true };
  }
}

const turnOf = (instruction: string) => instruction.split('，')[0];
/** Left turns pulse twice, right turns three times, so the direction can be felt without listening. */
const turnHaptic = (turn: string) => turn.includes('左') ? 'turnLeft' as const : turn.includes('右') ? 'turnRight' as const : 'tap' as const;

/** A detour is in progress until both walkers pass detour_until_m. */
function isDetouring(state: DemoState | null) {
  return !!state && (state.status === 'ACTIVE' || state.status === 'PAUSED') && state.detour_until_m != null && state.distance_m < state.detour_until_m;
}

/** Which side the replanned route passes the newest obstacle on. Map coordinates are (x, -z) rotated, +Y north. */
function detourSide(state: DemoState) {
  const obstacle = state.obstacles?.[state.obstacles.length - 1];
  if (!obstacle) return null;
  const forwardX = Math.sin(obstacle.heading), forwardZ = Math.cos(obstacle.heading);
  let widest = 0;
  for (const point of state.navigation?.points ?? []) {
    const dx = point.x - obstacle.point.x, dz = point.z - obstacle.point.z;
    if (Math.abs(dx * forwardX + dz * forwardZ) > 6) continue; // Only points level with the obstacle.
    const lateral = dx * forwardZ - dz * forwardX; // Positive is to the left of the walking direction.
    if (Math.abs(lateral) > Math.abs(widest)) widest = lateral;
  }
  return Math.abs(widest) < 0.3 ? null : widest > 0 ? '左' : '右';
}

/** The next thing the walker should expect, for the status card and the progress updates. */
function nextHint(world: DemoWorld, state: DemoState | null) {
  if (!state || (state.status !== 'ACTIVE' && state.status !== 'PAUSED')) return null;
  if (state.obstacle_active) return '下一步：绕过前方障碍';
  if (isDetouring(state) && state.detour_until_m != null) return `下一步：约 ${Math.max(1, Math.round(state.detour_until_m - state.distance_m))} 米后回到原路线`;
  const navigation = navigationForState(world, state);
  const step = world.route.steps[state.current_step];
  const next = world.route.steps[state.current_step + 1];
  const left = Math.max(1, Math.round((step ? navigation.step_end_distances[step.index] ?? step.end_m : navigation.total_distance_m) - state.distance_m));
  return next ? `下一步：约 ${left} 米后${turnOf(next.instruction)}` : `下一步：约 ${left} 米后到达${world.route.destination_name}`;
}

function describe(world: DemoWorld, state: DemoState | null) {
  const navigation = navigationForState(world, state);
  const total = navigation.total_distance_m;
  const walked = Math.min(total, state?.distance_m ?? 0);
  const step = world.route.steps[state?.current_step ?? 0];
  const next = world.route.steps[(state?.current_step ?? 0) + 1];
  const stepEnd = step ? navigation.step_end_distances[step.index] ?? step.end_m : 0;
  const status = state?.status === 'ACTIVE' && isDetouring(state) ? '正在绕行' : state ? STATUS_LABELS[state.status] : '准备连接';
  if (state?.status === 'DONE') return `已到达${world.route.destination_name}，全程 ${Math.round(total)} 米。`;
  const parts = [`${status}。已走 ${Math.round(walked)} 米，距${world.route.destination_name}还有 ${Math.round(total - walked)} 米。`];
  if (step) parts.push(`当前第 ${step.index + 1} 步，共 ${world.route.steps.length} 步：${step.instruction}。`);
  if (step && next && state?.status !== 'IDLE') parts.push(`约 ${Math.max(0, Math.round(stepEnd - walked))} 米后，${turnOf(next.instruction)}。`);
  if (state?.obstacle_active) parts.push('前方有障碍，已停下，可以说“绕行”从旁边通过。');
  else if (isDetouring(state)) parts.push('正在从障碍旁绕行，通过后回到原路线。');
  const passed = (state?.obstacles?.length ?? 0) - (state?.obstacle_active || isDetouring(state) ? 1 : 0);
  if (passed > 0) parts.push(`途中有 ${passed} 处障碍保留在原地，已绕过。`);
  return parts.join('');
}

export default function Assistance() {
  const { state, world, connection, busy, error, notice, stateRef, action: sendAction, sendText, retry } = useDemoSession();
  const [speech, setSpeech] = useState(true);
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [vibrationHint, setVibrationHint] = useState('');
  const [announcement, setAnnouncement] = useState({ id: 0, text: '', urgent: false });
  const [log, setLog] = useState<LogLine[]>([]);
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<Settings>({ rate: 'normal', progress: true, focus: false, vibration: true });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const speechRef = useRef(true);
  const rateRef = useRef(0.95);
  const speechPlayer = useRef<ReturnType<typeof createSpeechPlayer> | null>(null);
  const operationPending = useRef(false);
  const lastAnnouncement = useRef('');
  const approachAnnounced = useRef('');
  const progressAnnounced = useRef('');
  const logId = useRef(0);

  const addLog = useCallback((who: LogLine['who'], line: string) => {
    setLog(lines => [{ id: ++logId.current, who, text: line }, ...lines].slice(0, 8));
  }, []);
  const speak = useCallback((message: string) => {
    if (speechRef.current) speechPlayer.current?.speak(message);
  }, []);
  const announce = useCallback((message: string, urgent = false) => {
    setAnnouncement(previous => ({ id: previous.id + 1, text: message, urgent }));
    speak(message);
  }, [speak]);

  useEffect(() => { setSettings(loadSettings()); }, []);
  useEffect(() => {
    rateRef.current = RATES.find(rate => rate.key === settings.rate)?.value ?? 0.95;
    setHapticsEnabled(settings.vibration);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* per-device convenience only */ }
  }, [settings]);

  useEffect(() => {
    setVibrationHint(typeof navigator.vibrate === 'function' ? '出发、停下、遇障、转弯和到达都有不同的震动节奏。'
      : hapticsSupported() ? 'iPhone 只支持轻触反馈（需 iOS 18 及以上），没有长短节奏。' : '这个浏览器不支持震动，请留意语音和读屏提示。');
  }, []);

  useEffect(() => {
    const available = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    setSpeechAvailable(available);
    if (!available) { speechRef.current = false; setSpeech(false); return; }
    const player = createSpeechPlayer(window.speechSynthesis, message => new SpeechSynthesisUtterance(message), () => {
      speechRef.current = false;
      setSpeech(false);
      setAnnouncement(previous => ({ id: previous.id + 1, text: '暂时无法朗读，请使用读屏软件或查看文字提示。', urgent: false }));
    }, () => rateRef.current);
    speechPlayer.current = player;
    // iOS only lets pages speak after a gesture; the first tap unlocks later announcements.
    const unlock = () => { try { window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* optional */ } };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => { player.stop(); speechPlayer.current = null; window.removeEventListener('pointerdown', unlock); };
  }, []);

  const stateStatus = state?.status;
  const stateStep = state?.current_step;
  const obstacleActive = state?.obstacle_active;
  const detourUntil = state?.detour_until_m;
  useEffect(() => {
    const snapshot = stateRef.current;
    if (!snapshot) return;
    const key = `${snapshot.session_id}:${snapshot.status}:${snapshot.current_step}:${snapshot.obstacle_active}:${snapshot.detour_until_m}`;
    if (key === lastAnnouncement.current) return;
    const previous = lastAnnouncement.current;
    lastAnnouncement.current = key;
    if (previous === '') return; // The opening hint is spoken once the user first acts.
    const [, previousStatus, , previousObstacle, previousDetour] = previous.split(':');
    const detourStarted = snapshot.detour_until_m != null && previousDetour !== String(snapshot.detour_until_m) && !snapshot.obstacle_active;
    if (snapshot.obstacle_active) vibrate('obstacle');
    else if (snapshot.status === 'DONE') vibrate('arrived');
    else if (snapshot.status === 'CANCELLED') vibrate('cancelled');
    else if (detourStarted) vibrate('detourStart');
    else if (snapshot.status === 'PAUSED' && previousStatus === 'ACTIVE') vibrate('stop');
    else if (snapshot.status === 'ACTIVE' && previousStatus !== 'ACTIVE') vibrate('start');
    else if (snapshot.status === 'ACTIVE' && snapshot.detour_until_m == null && previousDetour !== 'null' && previousObstacle === 'false') vibrate('detourEnd');
    let message = snapshot.message;
    // A new detour (its end distance just appeared) also says which side and how far.
    if (detourStarted && snapshot.detour_until_m != null) {
      const side = detourSide(snapshot);
      message += `${side ? `从障碍${side}侧绕过，` : ''}约 ${Math.max(1, Math.round(snapshot.detour_until_m - snapshot.distance_m))} 米后回到原路线。`;
    }
    addLog('绒途', message);
    announce(message, snapshot.obstacle_active);
  }, [stateRef, stateStatus, stateStep, obstacleActive, detourUntil, announce, addLog]);

  useEffect(() => { if (error) { vibrate('failure'); announce(error, true); } }, [error, announce]);
  useEffect(() => { if (connection === 'reconnecting' || connection === 'error') vibrate('disconnected'); }, [connection]);

  // A heads-up roughly ten metres before each turn.
  const distance = state?.distance_m ?? 0;
  useEffect(() => {
    if (!world || !state || state.status !== 'ACTIVE' || isDetouring(state)) return;
    const step = world.route.steps[state.current_step];
    const next = world.route.steps[state.current_step + 1];
    if (!step || !next) return;
    const key = `${state.session_id}:${step.index}`;
    const left = (state.navigation?.step_end_distances[step.index] ?? step.end_m) - state.distance_m;
    if (left > 10 || left < 3 || approachAnnounced.current === key) return;
    approachAnnounced.current = key;
    const turn = turnOf(next.instruction);
    vibrate(turnHaptic(turn));
    const heads = `前方约 ${Math.round(left)} 米，${turn}。`;
    addLog('绒途', heads);
    announce(heads);
  }, [world, state, distance, announce, addLog]);

  // Regular distance updates; skipped near a turn or the end, where a more useful prompt is due.
  useEffect(() => {
    if (!settings.progress || !world || !state || state.status !== 'ACTIVE') return;
    const mark = Math.floor(state.distance_m / PROGRESS_STEP_M) * PROGRESS_STEP_M;
    const key = `${state.session_id}:${mark}`;
    if (mark === 0 || progressAnnounced.current === key) return;
    progressAnnounced.current = key;
    const navigation = navigationForState(world, state);
    const step = world.route.steps[state.current_step];
    const toTurn = (step ? navigation.step_end_distances[step.index] ?? step.end_m : 0) - state.distance_m;
    const toEnd = navigation.total_distance_m - state.distance_m;
    if (toEnd < 12 || (toTurn < 12 && state.current_step < world.route.steps.length - 1)) return;
    vibrate('progress');
    announce(`已走 ${mark} 米，还剩 ${Math.round(toEnd)} 米。`);
  }, [settings.progress, world, state, distance, announce]);

  // Keep the screen awake while walking. Browsers only allow this on HTTPS, so it quietly does nothing elsewhere.
  const walking = state?.status === 'ACTIVE';
  useEffect(() => {
    if (!walking || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;
    navigator.wakeLock.request('screen').then(sentinel => { if (released) void sentinel.release(); else lock = sentinel; }).catch(() => { /* optional */ });
    return () => { released = true; void lock?.release().catch(() => {}); };
  }, [walking]);

  // Ending needs a second tap within a few seconds, so a stray touch cannot stop the journey.
  useEffect(() => {
    if (!confirmCancel) return;
    const timer = window.setTimeout(() => setConfirmCancel(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmCancel]);

  const ready = connection === 'online' && !!state && !busy;
  const run = async (action: DemoAction) => {
    if (!ready || operationPending.current) return;
    operationPending.current = true;
    vibrate('tap');
    try {
      const result = await sendAction(action);
      if (action === 'reset' && result !== null) await sendAction('start');
    } finally {
      operationPending.current = false;
    }
  };
  const command = useCallback(async (message: string) => {
    const phrase = message.trim();
    if (!phrase) return;
    if (connection !== 'online' || !state || operationPending.current) {
      vibrate('failure');
      announce('还没有连上绒途，请稍等后再说一次。');
      return;
    }
    operationPending.current = true;
    vibrate('tap');
    addLog('你', phrase);
    try {
      const reply = await sendText(phrase);
      // State changes log and announce themselves; only replies that change nothing are added here.
      if (reply) {
        if (reply !== stateRef.current?.message || /重复|再说|前面|状态|走到哪/.test(phrase)) { addLog('绒途', reply); announce(reply); }
      } else { vibrate('failure'); announce('这条指令没有执行成功，请再试一次。'); }
    } finally {
      operationPending.current = false;
    }
  }, [connection, state, sendText, announce, addLog, stateRef]);

  const voice = useVoiceInput(phrase => void command(phrase));
  const toggleListening = () => {
    if (voice.listening) { vibrate('listenStop'); voice.stop(); return; }
    speechPlayer.current?.stop(); // Keep the speaker out of the microphone.
    vibrate('listenStart');
    voice.start();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const phrase = text;
    setText('');
    void command(phrase);
  };
  const cancel = () => {
    if (!confirmCancel) { setConfirmCancel(true); vibrate('confirm'); announce('确定要结束导航吗？再点一次结束。'); return; }
    setConfirmCancel(false);
    void run('cancel');
  };
  const chooseRate = (rate: RateKey) => {
    setSettings(current => ({ ...current, rate }));
    rateRef.current = RATES.find(item => item.key === rate)?.value ?? 0.95;
    speak(`语速：${RATES.find(item => item.key === rate)?.label}。`);
  };
  const toggleVibration = () => {
    const vibration = !settings.vibration;
    setHapticsEnabled(vibration);
    setSettings(current => ({ ...current, vibration }));
    if (vibration) vibrate('confirm');
    announce(vibration ? '震动提示已开启。' : '震动提示已关闭。');
  };
  const toggleProgress = () => {
    const progress = !settings.progress;
    setSettings(current => ({ ...current, progress }));
    announce(progress ? `已开启，每走 ${PROGRESS_STEP_M} 米报一次距离。` : '已关闭距离报数。');
  };
  const toggleFocus = () => {
    const focus = !settings.focus;
    setSettings(current => ({ ...current, focus }));
    announce(focus ? '已进入单屏模式，只保留导航按钮。' : '已退出单屏模式。');
    window.scrollTo(0, 0);
  };
  const whereAmI = () => { if (world) { vibrate('tap'); announce(describe(world, state)); } };
  const repeat = () => { vibrate('tap'); announce(state?.message || '还没有新的提示。'); };
  const toggleSpeech = () => {
    const enabled = !speechRef.current;
    speechRef.current = enabled;
    setSpeech(enabled);
    if (enabled) speak('语音播报已开启。');
    else speechPlayer.current?.stop();
  };

  const status = state?.status;
  const moving = status === 'ACTIVE';
  const journey = status === 'ACTIVE' || status === 'PAUSED';
  const detouring = isDetouring(state);
  const primary = moving ? { action: 'pause' as const, label: '停下', hint: detouring ? '正在绕行，点按立即停止' : '立即停止前进', icon: Pause, tone: 'stop' }
    : status === 'PAUSED' ? { action: 'resume' as const, label: state?.obstacle_active ? '绕行前进' : '继续前进', hint: state?.obstacle_active ? '障碍留在原地，绒途带你从旁边通过' : detouring ? '沿绕行路线继续' : '沿剩余路线出发', icon: Play, tone: 'go' }
    : status === 'DONE' || status === 'CANCELLED' ? { action: 'reset' as const, label: '重新出发', hint: '回到起点再走一次', icon: RotateCcw, tone: 'go' }
    : { action: 'start' as const, label: '开始导航', hint: world ? `从${world.route.start_name}前往${world.route.destination_name}` : '正在准备路线', icon: Play, tone: 'go' };
  const primaryBlocked = !ready;
  const PrimaryIcon = primary.icon;
  const total = world ? navigationForState(world, state).total_distance_m : 150;
  const walked = Math.min(total, state?.distance_m ?? 0);
  const step = world && state ? world.route.steps[state.current_step] : undefined;
  const upcoming = world ? nextHint(world, state) : null;
  const connectionText = connection === 'online' ? '已连接' : connection === 'loading' ? '正在连接' : connection === 'reconnecting' ? '连接中断，正在恢复' : '未连接';
  const voiceHint = voice.support === 'insecure' ? '当前地址不是 HTTPS，浏览器不开放麦克风。请点下方输入框，用输入法键盘上的话筒说话，再点发送。'
    : voice.support === 'unsupported' ? '这个浏览器不支持网页语音识别。请点下方输入框，用输入法键盘上的话筒说话。'
    : voice.listening ? '正在听，说完会自动发送。' : '点按话筒，说出指令，例如“停一下”“绕行”“前面有什么”。';

  const liveRegions = <>
    <p className={styles.screenReader} role="status" aria-live="polite" aria-atomic="true">{!announcement.urgent && <span key={announcement.id}>{announcement.text}</span>}</p>
    <p className={styles.screenReader} role="alert" aria-atomic="true">{announcement.urgent && <span key={announcement.id}>{announcement.text}</span>}</p>
    <noscript>无障碍引导需要开启 JavaScript。</noscript>
  </>;
  const statusTitle = `${moving && detouring ? '正在绕行' : state ? STATUS_LABELS[state.status] : '准备连接'}${state?.obstacle_active ? ' · 前方有障碍' : ''}`;
  const micButton = voice.support === 'ready' && <button className={styles.mic} data-listening={voice.listening} onClick={toggleListening} aria-pressed={voice.listening} aria-describedby="voice-hint">
    {voice.listening ? <MicOff size={40} aria-hidden="true" /> : <Mic size={40} aria-hidden="true" />}
    <span>{voice.listening ? '正在听 · 点按结束' : '点按说话'}</span>
  </button>;
  const cancelButton = <button onClick={cancel} aria-disabled={!ready || !journey} data-confirm={confirmCancel || undefined}><Square size={24} aria-hidden="true" />{confirmCancel ? '再点一次确认' : '结束导航'}</button>;

  // Single-screen mode: only what is needed while walking with the dog, sized to fit one viewport without scrolling.
  if (settings.focus) return <main className={styles.focus} aria-label="单屏导航">
    <header className={styles.focusHeader}>
      <span className={styles.connection} data-online={connection === 'online'}><i aria-hidden="true" />{connectionText}</span>
      <button onClick={toggleFocus} aria-pressed="true"><Minimize2 size={20} aria-hidden="true" />退出单屏</button>
    </header>
    <section className={styles.focusStatus} data-alert={state?.obstacle_active || undefined} aria-labelledby="focus-status">
      <h1 id="focus-status" className={styles.statusLabel}>{statusTitle}</h1>
      <p className={styles.focusMessage}>{voice.listening ? `正在听${voice.interim ? `：“${voice.interim}”` : '…'}` : error || state?.message || '正在连接绒途，请稍候。'}</p>
      <p className={styles.focusMeta}>{upcoming ?? `${Math.round(walked)} / ${Math.round(total)} 米`}{upcoming ? ` · ${Math.round(walked)}/${Math.round(total)} 米` : ''}</p>
    </section>
    <button className={styles.primary} data-tone={primary.tone} onClick={() => void run(primary.action)} aria-disabled={primaryBlocked} aria-describedby="primary-hint">
      <PrimaryIcon size={40} aria-hidden="true" /><span>{busy ? '正在处理…' : primary.label}</span>
      <small id="primary-hint">{primary.hint}</small>
    </button>
    <div className={styles.focusGrid}>
      {micButton || <button onClick={repeat}><Repeat size={26} aria-hidden="true" />重复提示</button>}
      <button onClick={() => void command('前面有什么')} aria-disabled={!ready}><Eye size={26} aria-hidden="true" />查询障碍</button>
      <button onClick={whereAmI} aria-disabled={!world}><MapPin size={26} aria-hidden="true" />我在哪</button>
      {cancelButton}
    </div>
    {voice.support !== 'ready' && <form className={styles.focusComposer} onSubmit={submit}>
      <label htmlFor="focus-command" className={styles.screenReader}>输入或用输入法话筒口述指令</label>
      <input id="focus-command" value={text} onChange={event => setText(event.target.value)} placeholder="说指令：点这里用键盘话筒" maxLength={300} autoComplete="off" enterKeyHint="send" />
      <button type="submit" aria-label="发送指令" aria-disabled={!ready || !text.trim()}><Send size={24} aria-hidden="true" /></button>
    </form>}
    <p id="voice-hint" className={styles.screenReader}>{voiceHint}</p>
    {liveRegions}
  </main>;

  return <main className={styles.page}>
    <a href="#controls" className={styles.skipLink}>跳到操作按钮</a>
    <header className={styles.header}>
      <Link href="/experience" className={styles.back}><ArrowLeft size={22} aria-hidden="true" />三维体验</Link>
      <h1>绒途 · 无障碍引导</h1>
      <span className={styles.connection} data-online={connection === 'online'}><i aria-hidden="true" />{connectionText}</span>
      <button className={styles.focusEnter} onClick={toggleFocus} aria-pressed="false"><Maximize2 size={22} aria-hidden="true" />单屏模式：只留导航按钮，不用滑动</button>
    </header>

    <section className={styles.status} aria-labelledby="status-title" data-alert={state?.obstacle_active || undefined}>
      <h2 id="status-title" className={styles.statusLabel}>{statusTitle}</h2>
      <p className={styles.message}>{state?.message || '正在连接绒途，请稍候。'}</p>
      <p className={styles.distance}><strong>{Math.round(walked)}</strong> / {Math.round(total)} 米{step ? ` · 第 ${step.index + 1} 步，共 ${world?.route.steps.length} 步` : ''}</p>
      {upcoming && <p className={styles.next}><Milestone size={22} aria-hidden="true" />{upcoming}</p>}
      <div className={styles.progress} role="progressbar" aria-label="路线进度" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(walked)} aria-valuetext={`已走 ${Math.round(walked)} 米，共 ${Math.round(total)} 米`}><span style={{ width: `${walked / total * 100}%` }} /></div>
      {(error || notice || connection === 'reconnecting' || connection === 'error') && <div className={styles.notice}>
        <p>{error || notice || '连接中断，画面暂停。恢复后需要手动继续。'}</p>
        {(error || connection !== 'online') && <button onClick={retry}>重新连接</button>}
      </div>}
    </section>

    <section id="controls" className={styles.controls} aria-label="导航操作" aria-busy={busy}>
      <button className={styles.primary} data-tone={primary.tone} onClick={() => void run(primary.action)} aria-disabled={primaryBlocked} aria-describedby="primary-hint">
        <PrimaryIcon size={34} aria-hidden="true" /><span>{busy ? '正在处理…' : primary.label}</span>
        <small id="primary-hint">{primary.hint}</small>
      </button>
      {state?.obstacle_active && <button className={styles.clear} onClick={() => void run('obstacle_bypass')} aria-disabled={!ready}>
        <Construction size={28} aria-hidden="true" />绕行障碍
      </button>}
      <div className={styles.grid}>
        <button onClick={() => void command('前面有什么')} aria-disabled={!ready}><Eye size={26} aria-hidden="true" />查询障碍</button>
        <button onClick={whereAmI} aria-disabled={!world}><MapPin size={26} aria-hidden="true" />我在哪</button>
        <button onClick={repeat}><Repeat size={26} aria-hidden="true" />重复提示</button>
        {cancelButton}
      </div>
    </section>

    <section className={styles.settings} aria-labelledby="settings-title">
      <h2 id="settings-title">播报设置</h2>
      <button className={styles.toggle} onClick={toggleSpeech} disabled={!speechAvailable} aria-pressed={speech}>
        {speech ? <Volume2 size={24} aria-hidden="true" /> : <VolumeX size={24} aria-hidden="true" />}
        {speechAvailable ? `语音播报：${speech ? '开' : '关'}` : '此浏览器不支持朗读'}
      </button>
      <div className={styles.rates} role="group" aria-labelledby="rate-title">
        <span id="rate-title"><Gauge size={22} aria-hidden="true" />语速</span>
        {RATES.map(rate => <button key={rate.key} onClick={() => chooseRate(rate.key)} aria-pressed={settings.rate === rate.key} disabled={!speechAvailable}>{rate.label}</button>)}
      </div>
      <button className={styles.toggle} onClick={toggleVibration} aria-pressed={settings.vibration} aria-describedby="vibration-hint">
        <Vibrate size={24} aria-hidden="true" />{`震动提示：${settings.vibration ? '开' : '关'}`}
      </button>
      <p id="vibration-hint" className={styles.hint}>{vibrationHint}</p>
      <button className={styles.toggle} onClick={toggleProgress} aria-pressed={settings.progress}>
        <Milestone size={24} aria-hidden="true" />{`每 ${PROGRESS_STEP_M} 米报距离：${settings.progress ? '开' : '关'}`}
      </button>
    </section>

    <section className={styles.voice} aria-labelledby="voice-title">
      <h2 id="voice-title">语音指令</h2>
      {micButton}
      <p id="voice-hint" className={styles.hint}>{voiceHint}</p>
      {voice.interim && <p className={styles.transcript} aria-hidden="true">“{voice.interim}”</p>}
      {voice.error && <p className={styles.voiceError} role="alert">{voice.error}</p>}
      <form className={styles.composer} onSubmit={submit}>
        <label htmlFor="assist-command">输入或口述指令</label>
        <div>
          <input id="assist-command" value={text} onChange={event => setText(event.target.value)} placeholder="例如：带我去街心花园" maxLength={300} autoComplete="off" enterKeyHint="send" />
          <button type="submit" aria-label="发送指令" aria-disabled={!ready || !text.trim()}><Send size={26} aria-hidden="true" /></button>
        </div>
      </form>
      <div className={styles.phrases} role="group" aria-label="常用指令">
        {QUICK_PHRASES.map(phrase => <button key={phrase} onClick={() => void command(phrase)} aria-disabled={!ready}>{phrase}</button>)}
      </div>
    </section>

    <section className={styles.mapSection} aria-labelledby="map-title">
      <h2 id="map-title">路线图</h2>
      <p className={styles.mapText}>{world ? describe(world, state) : '正在载入路线。'}</p>
      {world && (world.map ? <div className={styles.mapFrame}><RouteMap world={world} state={state} markerScale={1.8} large /></div>
        : <p className={styles.mapMissing}>路线图暂不可用，请收听文字描述。</p>)}
      {world && <ol className={styles.steps} aria-label="路线步骤">
        {world.route.steps.map(item => {
          const end = state?.navigation?.step_end_distances[item.index] ?? item.end_m;
          const complete = !!state && (state.distance_m >= end || state.status === 'DONE');
          const current = !complete && state?.current_step === item.index;
          return <li key={item.index} data-complete={complete} aria-current={current ? 'step' : undefined}>
            <span className={styles.screenReader}>{complete ? '已完成：' : current ? '当前：' : ''}</span>{item.instruction}
          </li>;
        })}
      </ol>}
    </section>

    {log.length > 0 && <section className={styles.log} aria-labelledby="log-title">
      <h2 id="log-title">最近对话</h2>
      <ol>{log.map(line => <li key={line.id}><b>{line.who}：</b>{line.text}</li>)}</ol>
    </section>}

    {liveRegions}
  </main>;
}
