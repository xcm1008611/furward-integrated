'use client';

/* eslint-disable react-hooks/set-state-in-effect -- Hydrate browser speech/storage capabilities and announce external navigation transitions after mount. */

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Volume2, VolumeX, Send, RotateCcw, Pause, Play, Square, ArrowRight, Check } from 'lucide-react';
import { useDemoSession } from '@/lib/demo-session';
import { navigationForState, STATUS_LABELS, type DemoAction } from '@/lib/demo-types';
import { createSpeechPlayer } from './speech';
import RouteMap from './RouteMap';
import styles from './experience.module.css';

const CityScene = dynamic(() => import('./CityScene'), { ssr: false, loading: () => <div className={styles.scenePlaceholder}>正在准备城市画面…</div> });
type ChatLine = { role: 'user' | 'assistant'; text: string };

export default function Experience() {
  const { state, world, connection, busy, error, notice, stateRef, receivedAt, action: sendAction, sendText, retry } = useDemoSession();
  const [view, setView] = useState<'follow' | 'overview'>('follow');
  const [text, setText] = useState('');
  const [speech, setSpeech] = useState(false);
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [speechError, setSpeechError] = useState('');
  const [announcement, setAnnouncement] = useState({ id: 0, text: '' });
  const [chat, setChat] = useState<ChatLine[]>([]);
  const chatViewport = useRef<HTMLDivElement>(null);
  const chatSession = useRef('');
  const lastAnnouncement = useRef('');
  const speechRef = useRef(false);
  const speechPlayer = useRef<ReturnType<typeof createSpeechPlayer> | null>(null);
  const operationPending = useRef(false);

  const announce = useCallback((message: string) => {
    // A fresh child also announces repeated replies, without rereading chat history.
    setAnnouncement(previous => ({ id: previous.id + 1, text: message }));
  }, []);

  useEffect(() => {
    const available = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    setSpeechAvailable(available);
    if (!available) return;
    const player = createSpeechPlayer(window.speechSynthesis, message => new SpeechSynthesisUtterance(message), () => {
      const message = '暂时无法朗读，请查看文字提示。你可以再次点击“开启播报”尝试。';
      speechRef.current = false;
      setSpeech(false);
      setSpeechError(message);
      announce(message);
    });
    speechPlayer.current = player;
    return () => { player.stop(); speechPlayer.current = null; };
  }, [announce]);

  const speak = useCallback((message: string) => {
    if (speechRef.current) speechPlayer.current?.speak(message);
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
    lastAnnouncement.current = key;
    announce(snapshot.message);
    speak(snapshot.message);
  }, [stateRef, stateStatus, stateStep, obstacleActive, detourUntil, speak, announce]);

  useEffect(() => {
    const id = state?.session_id;
    if (!id || chatSession.current === id) return;
    chatSession.current = id;
    let saved: ChatLine[] = [];
    try {
      const candidate = JSON.parse(sessionStorage.getItem(`furward-chat-${id}`) || '[]');
      if (Array.isArray(candidate)) saved = candidate.filter(line => ['assistant', 'user'].includes(line.role) && typeof line.text === 'string').slice(-12);
    } catch { /* Chat works without browser storage. */ }
    setChat(saved.length ? saved : [{ role: 'assistant', text: '我是绒途。准备好后，点“开始体验”，或告诉我“带我去街心花园”。' }]);
  }, [state?.session_id]);

  useEffect(() => {
    if (chatSession.current) {
      try { sessionStorage.setItem(`furward-chat-${chatSession.current}`, JSON.stringify(chat.slice(-12))); } catch { /* optional storage */ }
    }
    if (chatViewport.current) chatViewport.current.scrollTop = chatViewport.current.scrollHeight;
  }, [chat]);

  const run = async (action: DemoAction, unavailable: boolean) => {
    // aria-disabled keeps focus; the synchronous lock blocks clicks/Enter before
    // React commits busy, and spans both requests in a replay.
    if (unavailable || busy || operationPending.current || connection !== 'online') return;
    operationPending.current = true;
    try {
      const result = await sendAction(action);
      if (action === 'reset' && result !== null) await sendAction('start');
    } finally {
      operationPending.current = false;
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || !state || busy || operationPending.current || connection !== 'online') return;
    operationPending.current = true;
    try {
      setText('');
      setChat(lines => [...lines.slice(-11), { role: 'user', text: message }]);
      const reply = await sendText(message);
      if (reply) {
        setChat(lines => [...lines.slice(-11), { role: 'assistant', text: reply }]);
        announce(reply);
        speak(reply);
      } else {
        setChat(lines => [...lines.slice(-11), { role: 'assistant', text: '这条指令没有执行成功。请查看连接提示后再试一次。' }]);
        setText(message);
      }
    } finally {
      operationPending.current = false;
    }
  };
  const toggleSpeech = () => {
    const enabled = !speechRef.current;
    speechRef.current = enabled;
    setSpeech(enabled);
    setSpeechError('');
    if (enabled) speak(state?.message || '语音播报已开启。');
    else speechPlayer.current?.stop();
  };
  const ready = connection === 'online' && !!state && !busy;
  const navigation = world ? navigationForState(world, state) : null;
  const totalDistance = navigation?.total_distance_m ?? 150;
  const progress = state ? Math.max(0, Math.min(100, state.distance_m / totalDistance * 100)) : 0;
  const detouring = !!state && ['ACTIVE', 'PAUSED'].includes(state.status) && state.detour_until_m != null && state.distance_m < state.detour_until_m;
  const primary = state?.status === 'ACTIVE' ? { action: 'pause' as const, label: '停下', icon: Pause }
    : state?.status === 'PAUSED' ? { action: 'resume' as const, label: state.obstacle_active ? '绕行前进' : '继续前进', icon: Play }
    : state?.status === 'DONE' || state?.status === 'CANCELLED' ? { action: 'reset' as const, label: '再来一次', icon: RotateCcw }
    : { action: 'start' as const, label: '开始体验', icon: Play };
  const PrimaryIcon = primary.icon;
  const primaryUnavailable = !ready;
  const journeyUnavailable = !ready || !['ACTIVE', 'PAUSED'].includes(state?.status ?? '');
  const obstacleUnavailable = journeyUnavailable || (!state?.obstacle_active && detouring);
  const statusLabel = state?.status === 'ACTIVE' && detouring ? '正在绕行' : state ? STATUS_LABELS[state.status] : '准备连接';
  const connectionText = connection === 'online' ? '已连接' : connection === 'loading' ? '正在连接…' : connection === 'reconnecting' ? '连接中断，正在恢复…' : '连接未完成';

  return <main className={styles.experience}>
    <a href="#journey-controls" className={styles.skipLink}>跳到路线控制</a>
    <Link href="/assistance" className={styles.skipLink}>切换到无障碍引导页</Link>
    <header className={styles.topbar}>
      <Link href="/" className={styles.brand} aria-label="绒途 Furward 首页"><ArrowLeft aria-hidden="true" size={17} /><span>绒途 <b>Furward</b></span></Link>
      <h1>城市引导体验</h1>
      <span className={styles.connection} data-connected={connection === 'online'}><i aria-hidden="true" />{connectionText}</span>
    </header>

    <div className={styles.workspace}>
      <section className={styles.cityPanel} aria-label="城市路线画面">
        <div className={styles.canvasBar}>
          <p>{world ? `${world.route.start_name} → ${world.route.destination_name}` : '西街口 → 街心花园'}</p>
          <div className={styles.viewToggle} role="group" aria-label="城市视角">
            <button aria-pressed={view === 'follow'} onClick={() => setView('follow')}>跟随</button>
            <button aria-pressed={view === 'overview'} onClick={() => setView('overview')}>全景</button>
          </div>
        </div>
        <div className={styles.canvasArea}>
          {world ? <CityScene world={world} stateRef={stateRef} receivedAt={receivedAt} view={view} /> : <div className={styles.scenePlaceholder}>{connection === 'error' ? '连接恢复后，将在这里载入城市。' : '正在准备你的路线…'}</div>}
          <div className={styles.canvasCaption}><span>{view === 'follow' ? '绒途在前，你在身后。' : '拖动旋转，滚轮或双指缩放。'}</span><span>虚构城市 · 演示路线</span></div>
          {world && <div className={styles.minimap}><RouteMap world={world} state={state} /></div>}
        </div>
        <div className={styles.sceneFooter}><span>从出发到到达，每一步都有回应。</span><span>本次体验独立保存</span></div>
      </section>

      <aside className={styles.controlPanel} aria-label="路线与文字交流">
        <section className={styles.journey} id="journey-controls" aria-labelledby="journey-title">
          <div className={styles.sectionHeading}><h2 id="journey-title">这段路，一起走</h2><span className={styles.status} data-active={state?.status === 'ACTIVE'}>{statusLabel}</span></div>
          <p className={styles.instruction}>{state?.message || '连上绒途后，就可以开始这段城市旅程。'}</p>
          <div className={styles.progressLabel}><span>已行进 <strong>{(state?.distance_m ?? 0).toFixed(1)}</strong> 米</span><span>全程 {totalDistance.toFixed(1)} 米</span></div>
          <div className={styles.progressTrack} role="progressbar" aria-label="路线行进进度" aria-valuemin={0} aria-valuemax={totalDistance} aria-valuenow={Math.min(totalDistance, Math.max(0, state?.distance_m ?? 0))} aria-valuetext={`已行进 ${(state?.distance_m ?? 0).toFixed(1)} 米，全程 ${totalDistance.toFixed(1)} 米`}><span style={{ width: `${progress}%` }} /></div>
          <div className={styles.mainControls} aria-busy={busy}>
            <button className={styles.primary} onClick={() => void run(primary.action, primaryUnavailable)} aria-disabled={primaryUnavailable}><PrimaryIcon size={17} aria-hidden="true" />{busy ? '正在处理…' : primary.label}</button>
            <button onClick={() => void run('cancel', journeyUnavailable)} aria-disabled={journeyUnavailable}><Square size={15} aria-hidden="true" />结束</button>
          </div>
          <div className={styles.auxControls}>
            <button onClick={() => void run(state?.obstacle_active ? 'obstacle_bypass' : 'obstacle', obstacleUnavailable)} aria-disabled={obstacleUnavailable}>{state?.obstacle_active ? '绕行障碍' : detouring ? '绕行中' : '模拟障碍'}</button>
            <button onClick={toggleSpeech} disabled={!speechAvailable} aria-pressed={speech}>{speech ? <Volume2 size={16} aria-hidden="true" /> : <VolumeX size={16} aria-hidden="true" />}{speechAvailable ? (speech ? '播报已开启' : '开启播报') : '使用文字提示'}</button>
          </div>
          {speechError && <p className={styles.hint}>{speechError}</p>}
          {state?.obstacle_active && <p className={styles.hint}>前方有障碍。点击“绕行前进”，或输入“绕行”，绒途会带你从旁边经过。</p>}
          {!state?.obstacle_active && detouring && ['ACTIVE', 'PAUSED'].includes(state?.status ?? '') && <p className={styles.hint}>{state?.status === 'PAUSED' ? '绕行已暂停，点击“继续前进”沿当前路线继续。' : '正在沿新路线绕过障碍，人和绒途通过后回到原路线。'}</p>}
          {(error || connection === 'reconnecting' || notice) && <div className={styles.notice} role="status">
            <p>{error || (connection === 'reconnecting' ? '正在恢复连接。画面会暂时停住；长时间离线后，需要手动继续。' : notice)}</p>
            {(error || connection === 'reconnecting') && <button onClick={retry}>重新连接 <ArrowUpRight size={14} aria-hidden="true" /></button>}
          </div>}
          <ol className={styles.steps} aria-label="路线步骤">
            {world?.route.steps.map(step => {
              const end = navigation?.step_end_distances[step.index] ?? step.end_m;
              const start = step.index === 0 ? 0 : navigation?.step_end_distances[step.index - 1] ?? step.start_m;
              const addedDistance = end - start - step.distance_m;
              const instruction = addedDistance > 0.05 ? `${step.instruction.replace(/约\s*[\d.]+\s*米/, `约 ${Math.round(end - start)} 米`)}（含绕行）` : step.instruction;
              const complete = !!state && (state.distance_m >= end || state.status === 'DONE');
              const current = !complete && state?.current_step === step.index;
              return <li key={step.index} aria-current={current ? 'step' : undefined} data-complete={complete}>
                <span className={styles.stepMarker} aria-hidden="true">{complete ? <Check size={13} /> : current ? <ArrowRight size={13} /> : <i />}</span>
                <span>{instruction}</span>
              </li>;
            })}
          </ol>
        </section>

        <section className={styles.conversation} aria-labelledby="conversation-title">
          <div className={styles.sectionHeading}><h2 id="conversation-title">和绒途说句话</h2><span>文字交流</span></div>
          <div className={styles.chat} aria-label="交流记录" ref={chatViewport}>
            {chat.map((line, index) => <div className={styles.chatLine} key={index} data-role={line.role}><span>{line.role === 'assistant' ? '绒途' : '你'}</span><p>{line.text}</p></div>)}
          </div>
          <form onSubmit={submit} className={styles.composer} aria-busy={busy}>
            <label htmlFor="demo-message">想去哪里，或需要停下？</label>
            <div><input id="demo-message" value={text} onChange={event => setText(event.target.value)} placeholder="例如：带我去街心花园" maxLength={300} disabled={!state} autoComplete="off" /><button type="submit" aria-label="发送文字指令" aria-disabled={!ready || !text.trim()}><Send size={18} aria-hidden="true" /></button></div>
          </form>
          <p className={styles.textHint}>可以说“停下”“继续”“绕行”或“结束导航”。</p>
        </section>
      </aside>
    </div>
    <p className={styles.screenReader} role="status" aria-live="polite" aria-atomic="true"><span key={announcement.id} data-announcement-id={announcement.id}>{announcement.text}</span></p>
    <noscript>城市交互需要开启 JavaScript。你可以返回首页阅读绒途项目介绍。</noscript>
  </main>;
}
