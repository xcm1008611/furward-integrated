'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Section } from '@/lib/content';
import FurwardLiquid, { type HeroPlaybackStatus, type HeroStage } from './FurwardLiquid';

function contours() {
  const cols = 90, rows = 58, sx = 1600 / cols, sy = 1000 / rows;
  const field = (x: number, y: number) => Math.sin(x * .004 + .9 * Math.sin(y * .005)) + Math.cos(y * .005 - .8 * Math.cos(x * .003)) + .34 * Math.sin(x * .009 + y * .003);
  const values = Array.from({ length: rows + 1 }, (_, j) => Array.from({ length: cols + 1 }, (_, i) => field(i * sx, j * sy)));
  const paths: string[] = [];
  for (let level = -2.1; level < 2.2; level += .39) {
    let path = '';
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const points = [[i * sx, j * sy], [(i + 1) * sx, j * sy], [(i + 1) * sx, (j + 1) * sy], [i * sx, (j + 1) * sy]];
      const corners = [values[j][i], values[j][i + 1], values[j + 1][i + 1], values[j + 1][i]];
      const hits: number[][] = [];
      for (let k = 0; k < 4; k++) {
        const next = (k + 1) % 4;
        if ((corners[k] >= level) === (corners[next] >= level)) continue;
        const t = (level - corners[k]) / (corners[next] - corners[k]);
        hits.push([points[k][0] + (points[next][0] - points[k][0]) * t, points[k][1] + (points[next][1] - points[k][1]) * t]);
      }
      for (let k = 0; k + 1 < hits.length; k += 2) path += `M${hits[k][0].toFixed(1)},${hits[k][1].toFixed(1)}L${hits[k + 1][0].toFixed(1)},${hits[k + 1][1].toFixed(1)}`;
    }
    paths.push(path);
  }
  return paths;
}

export default function WhiteHero({ section, onOpenMenu }: { section: Section; onOpenMenu: (button: HTMLButtonElement) => void }) {
  const host = useRef<HTMLElement>(null);
  const [playback, setPlayback] = useState<{ status: HeroPlaybackStatus; runId: number }>({ status: 'idle', runId: 0 });
  const [mode, setMode] = useState<HeroStage>('labrador');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false);
  const paths = useMemo(() => contours(), []);
  const dog = section.images.find(image => image.id === 'hero-dog'), robot = section.images.find(image => image.id === 'hero-robot');
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(reduced.matches);
    update();
    reduced.addEventListener('change', update); return () => reduced.removeEventListener('change', update);
  }, []);
  const playing = playback.status === 'playing';
  const buttonLabel = { idle: '播放演示', playing: '暂停', paused: '继续播放', finished: '重新播放' }[playback.status];
  const hint = failed ? '画面未能加载，请刷新重试' : !ready ? '正在准备画面' : playback.status === 'idle' ? '一次播放，看见陪伴的下一步' : playback.status === 'finished' ? '每一步，都有温柔回应' : playback.status === 'paused' ? '已暂停，点击继续播放' : reducedMotion ? '正在切换到机器狗' : '拉布拉多与机器狗，在此交汇';
  const togglePlayback = () => {
    if (!ready || failed) return;
    if (playback.status === 'idle' || playback.status === 'finished') setMode('labrador');
    setPlayback(current => current.status === 'playing'
      ? { ...current, status: 'paused' }
      : current.status === 'paused'
        ? { ...current, status: 'playing' }
        : { status: 'playing', runId: current.runId + 1 });
  };
  const descriptions: Record<string, string> = { robot: '机器人视角：视障人士与 AI 机器狗一起前行。', flow: '流动视角：在机器狗与拉布拉多导盲犬之间切换。', labrador: '拉布拉多视角：视障人士与拉布拉多导盲犬一起前行。' };
  const title = section.title.split(/(?<=[，,])/).filter(Boolean);
  return <section ref={host} className={`ss-hero ${!playing || reducedMotion ? 'ss-paused' : ''} ${failed ? 'ss-load-error' : ''}`} id="home" aria-labelledby="hero-title" data-mode={mode} data-playback={playback.status} data-ready={ready}>
    <div className="ss-landscape" aria-hidden="true"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">{paths.map((d, i) => <path key={i} d={d}/>)}</svg></div>
    <div className="ss-ghost-type" aria-hidden="true"><span>FUR</span><span>WARD</span></div>
    <div className="ss-coordinate ss-coordinate-top" aria-hidden="true"><span>+ 31° N</span><span>121° E +</span></div>
    <FurwardLiquid host={host} dog={dog} robot={robot} mode={mode} playback={{ ...playback, reducedMotion }} onStageChange={setMode} onComplete={() => setPlayback(current => ({ ...current, status: 'finished' }))} onReady={(loaded, error) => {
      setReady(loaded); setFailed(!!error);
      if (!loaded) {
        setMode('labrador');
        setPlayback(current => current.status === 'idle' ? current : { ...current, status: 'idle' });
      }
    }}/>
    <div className="ss-ground" aria-hidden="true"/>
    <header className="ss-header">
      <a className="ss-wordmark" href="#home" aria-label="绒途 Furward 首页"><span>FUR</span><strong>WARD</strong><small>绒途</small></a>
      <div className="ss-header-note"><span className="ss-little-star">✳</span> A LITTLE WARMTH.<br/><span>A WAY FORWARD.</span></div>
      <div className="ss-header-actions"><a className="ss-explore" href="/experience"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18L18 5M5 5h13v13"/></svg><span>城市体验</span></a><button type="button" className="ss-menu-toggle" aria-label="打开菜单" aria-haspopup="dialog" onClick={event => onOpenMenu(event.currentTarget)}><span/><span/></button></div>
    </header>
    <div className="ss-hero-copy"><div className="ss-eyebrow"><span/> {section.eyebrow}</div><h1 id="hero-title">{title.map((line, i) => { const words = Array.from(line); const split = Math.max(0, words.length - 3); return <span className="ss-title-line" key={i}>{words.slice(0, split).join('')}<span className="ss-serif-word">{words.slice(split).join('')}</span></span>; })}</h1><p>{section.description.split(/(?<=[。])/).filter(Boolean).map((line, i) => <span className="ss-description-line" key={i}>{line}</span>)}</p><div className="ss-copy-rule"><span>FUR + FORWARD / MEET FURWARD</span><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M5 5L25 25M25 8v17H8"/></svg></div></div>
    <aside className="ss-right-note"><span className="ss-cross">+</span><p>SAME TRUST.<br/><em>New possibilities.</em></p><div className="ss-right-rule"/><span className="ss-tiny">HUMAN FIRST.<br/>ALWAYS.</span></aside>
    <aside className="ss-field-card" aria-label="当前展示"><span className="ss-field-tab">THE NEXT STEP</span><div className="ss-field-inner"><svg className="ss-dog-mark" viewBox="0 0 90 45" aria-hidden="true"><path d="M8 29l10-10 13 2 8-8 20 1 8-7 13 4-5 9-10 1-6 9H31l-8-5-5 9M35 28l-5 12M56 29l5 10M14 20L6 12"/></svg><span>{mode === 'labrador' ? '拉布拉多导盲犬' : mode === 'robot' ? 'AI 导盲伙伴' : '两种陪伴 · 同一信任'}</span><div className="ss-field-divider"/><div className="ss-field-code"><span className="ss-status-dot"/><span>FURWARD / 001</span></div><small>为自主前行而设计</small></div></aside>
    <div className="ss-playback-controls">
      <button type="button" className="ss-playback-button" disabled={!ready || failed} onClick={togglePlayback} aria-describedby="hero-playback-hint">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d={playing ? 'M7 5V15M13 5V15' : 'M7 4L15 10L7 16Z'}/></svg>
        {buttonLabel}
      </button>
      <span id="hero-playback-hint" className="ss-playback-hint">{hint}</span>
    </div>
    <footer className="ss-hero-footer"><a className="ss-footer-caption" href={section.buttonHref}><span className="ss-footer-plus" aria-hidden="true">↓</span><span>{section.buttonLabel}</span></a>
      <ol className="ss-sequence" aria-label="演示播放阶段">{([['labrador', '拉布拉多'], ['flow', '流动视角'], ['robot', '机器狗']] as const).map(([stage, label], index) => <li key={stage} aria-current={mode === stage ? 'step' : undefined}>{index > 0 && <span className="ss-sequence-arrow" aria-hidden="true">→</span>}<span className="ss-sequence-label">{label}</span></li>)}</ol>
      <div className="ss-footer-right"><span className="ss-concept-label">AI 概念影像</span></div>
    </footer>
    {!ready && <p className="ss-loading" role="status">{failed ? '画面未能加载，请刷新页面重试。' : <>正在唤醒你的伙伴 <span>···</span></>}</p>}
    <span className="ss-sr-only" role="status" aria-live="polite">{descriptions[mode]}{playback.status === 'paused' ? '演示已暂停。' : playback.status === 'finished' ? '演示结束，可以重新播放。' : ''}</span>
  </section>;
}
