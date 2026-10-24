'use client';

import { useEffect, useId, useRef, type CSSProperties, type RefObject } from 'react';
import type { ImageSlot } from '@/lib/content';
import { advanceHeroTime, getHeroFrame, HERO_DURATION, REDUCED_HERO_DURATION, type HeroPlaybackStatus, type HeroStage } from './hero-timeline';

export type LiquidMode = 'robot' | 'flow' | 'labrador' | 'overlay';
export type { HeroPlaybackStatus, HeroStage } from './hero-timeline';
type HeroPlayback = { status: HeroPlaybackStatus; runId: number; reducedMotion: boolean };
type Props = {
  robot?: ImageSlot; dog?: ImageSlot; mode?: LiquidMode; paused?: boolean;
  host: RefObject<HTMLElement | null>; onReady?: (ready: boolean, failed?: boolean) => void;
  playback?: HeroPlayback; onStageChange?: (stage: HeroStage) => void; onComplete?: () => void;
};

/** Original Furward white-home liquid algorithm, with component-scoped refs.
 * The two masks are complementary: transparent cutouts never show two dogs. */
export default function FurwardLiquid({ robot, dog, mode = 'flow', paused = false, host, onReady, playback, onStageChange, onComplete }: Props) {
  const id = `liquid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const robotLayer = useRef<HTMLDivElement>(null), dogLayer = useRef<HTMLDivElement>(null);
  const robotImage = useRef<HTMLImageElement>(null), dogImage = useRef<HTMLImageElement>(null);
  const ribbon = useRef<SVGSVGElement>(null), fill = useRef<SVGPathElement>(null), top = useRef<SVGPathElement>(null), bottom = useRef<SVGPathElement>(null);
  const displacement = useRef<SVGFEDisplacementMapElement>(null);
  const render = useRef<(smoothing?: number) => void>(() => {});
  const readyCallback = useRef(onReady);
  const stageCallback = useRef(onStageChange);
  const completeCallback = useRef(onComplete);
  const state = useRef({ mode, paused, playback, runReducedMotion: playback?.reducedMotion ?? false, elapsed: 0, completed: false, stage: null as HeroStage | null, time: 7, pointerX: 0, pointerY: 0, x: 0, y: 0, half: 0, center: 0, amplitude: 0, width: 0, height: 0, ready: false, last: 0 });

  useEffect(() => { readyCallback.current = onReady; stageCallback.current = onStageChange; completeCallback.current = onComplete; }, [onReady, onStageChange, onComplete]);
  useEffect(() => {
    const s = state.current, previous = s.playback;
    if (playback && (!previous || playback.runId !== previous.runId)) {
      s.elapsed = 0; s.completed = false; s.stage = null; s.runReducedMotion = playback.reducedMotion;
    }
    // A motion preference change applies to the next play, preserving the
    // geometry and duration of a running or paused sequence.
    if (playback?.status === 'idle') { s.elapsed = 0; s.completed = false; s.runReducedMotion = playback.reducedMotion; }
    if (playback?.status === 'finished') {
      s.elapsed = s.runReducedMotion ? REDUCED_HERO_DURATION : HERO_DURATION;
      s.completed = true;
    }
    if (playback?.status !== previous?.status || playback?.runId !== previous?.runId) s.last = 0;
    s.mode = mode; s.paused = paused; s.playback = playback;
    if (s.ready) render.current(playback || paused || mode === 'overlay' ? 1 : .065);
  }, [mode, paused, playback]);
  useEffect(() => {
    const hero = host.current;
    if (!hero) return;
    let disposed = false, frame = 0;
    const imageListenerCleanup: Array<() => void> = [];
    const s = state.current;
    s.ready = false; s.last = 0; s.time = 7;
    readyCallback.current?.(false);
    const paint = (smoothing = .065) => {
      if (!robotLayer.current || !dogLayer.current) return;
      const w = s.width, h = s.height;
      let t = s.time, distortion = 0;
      robotLayer.current.style.visibility = 'visible'; dogLayer.current.style.visibility = 'visible';
      if (s.playback) {
        const sequence = getHeroFrame(s.elapsed, s.runReducedMotion);
        if (s.stage !== sequence.stage) { s.stage = sequence.stage; stageCallback.current?.(sequence.stage); }
        hero.style.setProperty('--px', '0px'); hero.style.setProperty('--py', '0px');
        if (sequence.fullDog || sequence.complete || s.runReducedMotion) {
          robotLayer.current.style.clipPath = 'none'; dogLayer.current.style.clipPath = 'none';
          const fade = sequence.complete ? 1 : sequence.fullDog ? 0 : sequence.fade;
          robotLayer.current.style.opacity = String(fade); dogLayer.current.style.opacity = String(1 - fade);
          robotLayer.current.style.visibility = fade === 0 ? 'hidden' : 'visible';
          dogLayer.current.style.visibility = fade === 1 ? 'hidden' : 'visible';
          if (ribbon.current) ribbon.current.style.visibility = 'hidden';
          displacement.current?.setAttribute('scale', '0');
          return;
        }
        s.half = h * sequence.half; s.center = h * sequence.center; s.amplitude = h * sequence.amplitude;
        t = sequence.time; distortion = (4 + 3 * Math.sin(t * .6)) * sequence.flowWeight;
      } else if (s.mode === 'overlay') {
        robotLayer.current.style.clipPath = 'none'; dogLayer.current.style.clipPath = 'none';
        robotLayer.current.style.opacity = '.5'; dogLayer.current.style.opacity = '.5';
        if (ribbon.current) ribbon.current.style.visibility = 'hidden';
        displacement.current?.setAttribute('scale', '0');
        return;
      }
      robotLayer.current.style.opacity = '1'; dogLayer.current.style.opacity = '1';
      if (ribbon.current) {
        ribbon.current.style.visibility = 'visible';
        ribbon.current.style.opacity = s.playback ? String(getHeroFrame(s.elapsed, s.runReducedMotion).flowWeight) : '1';
      }
      if (!s.playback) {
        const autoHalf = h * (.19 + .045 * Math.sin(t * .37));
        const targetHalf = s.mode === 'robot' ? 0 : s.mode === 'labrador' ? h * 1.8 : autoHalf;
        const targetCenter = h * (.66 + .15 * Math.sin(t * .25)) + s.pointerY * h * .12;
        const targetAmplitude = s.mode === 'flow' ? h * .055 : 0;
        s.half += (targetHalf - s.half) * smoothing;
        s.center += (targetCenter - s.center) * smoothing;
        s.amplitude += (targetAmplitude - s.amplitude) * smoothing;
        s.x += (s.pointerX * 11 - s.x) * .035;
        s.y += (s.pointerY * 5 - s.y) * .035;
        hero.style.setProperty('--px', `${s.x.toFixed(2)}px`);
        hero.style.setProperty('--py', `${s.y.toFixed(2)}px`);
        distortion = s.paused || s.mode !== 'flow' ? 0 : 4 + 3 * Math.sin(t * .6);
      }
      const tops: string[] = [], bottoms: string[] = [], samples = w < 760 ? 46 : 76;
      for (let i = 0; i <= samples; i++) {
        const x = -8 + (w + 16) * i / samples, p = i / samples;
        const wave = Math.sin(p * 6.2 + t * .56) * s.amplitude + Math.sin(p * 11.4 - t * .32) * s.amplitude * .32;
        const thickness = s.half * (1 + .15 * Math.sin(p * 5.8 - t * .45));
        tops.push(`${x.toFixed(1)},${(s.center + wave - thickness).toFixed(1)}`);
        bottoms.push(`${x.toFixed(1)},${(s.center + wave + thickness).toFixed(1)}`);
      }
      const topPath = `M${tops.join('L')}`, bottomPath = `M${bottoms.join('L')}`;
      const band = `${topPath}L${bottoms.slice().reverse().join('L')}Z`;
      const inverse = `M-20,-20H${w + 20}V${h + 20}H-20Z${band}`;
      robotLayer.current.style.clipPath = `path(evenodd, "${inverse}")`;
      dogLayer.current.style.clipPath = `path("${band}")`;
      fill.current?.setAttribute('d', band); top.current?.setAttribute('d', topPath); bottom.current?.setAttribute('d', bottomPath);
      displacement.current?.setAttribute('scale', String(distortion));
    };
    render.current = paint;
    const resize = () => { s.width = hero.clientWidth; s.height = hero.clientHeight; ribbon.current?.setAttribute('viewBox', `0 0 ${s.width} ${s.height}`); if (s.ready) paint(1); };
    const pointer = (event: PointerEvent) => {
      if (s.paused || s.playback) return;
      const bounds = hero.getBoundingClientRect();
      s.pointerX = ((event.clientX - bounds.left) / bounds.width - .5) * 2;
      s.pointerY = ((event.clientY - bounds.top) / bounds.height - .5) * 2;
    };
    const leave = () => { s.pointerX = 0; s.pointerY = 0; };
    const visibility = () => { s.last = 0; };
    const animate = (now: number) => {
      if (disposed) return;
      const delta = s.last ? (now - s.last) / 1000 : 0; s.last = now;
      if (s.ready && !document.hidden) {
        if (s.playback) {
          if (s.playback.status === 'playing' && !s.completed) {
            s.elapsed = advanceHeroTime(s.elapsed, delta, true, s.runReducedMotion);
            paint();
            if (getHeroFrame(s.elapsed, s.runReducedMotion).complete) {
              s.completed = true; completeCallback.current?.();
            }
          }
        } else if (s.mode !== 'overlay') {
          if (!s.paused) s.time += Math.min(delta, .06);
          if (!s.paused || Math.abs(s.half - (s.mode === 'robot' ? 0 : s.mode === 'labrador' ? s.height * 1.8 : s.half)) > .15) paint();
        }
      }
      frame = requestAnimationFrame(animate);
    };
    const imageReady = (img: HTMLImageElement | null) => {
      if (!img) return Promise.reject(new Error('Missing image'));
      if (img.complete) return img.naturalWidth ? Promise.resolve() : Promise.reject(new Error('Image unavailable'));
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => { img.removeEventListener('load', loaded); img.removeEventListener('error', failed); };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Image unavailable')); };
        imageListenerCleanup.push(cleanup);
        img.addEventListener('load', loaded, { once: true }); img.addEventListener('error', failed, { once: true });
      });
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(hero);
    hero.addEventListener('pointermove', pointer, { passive: true }); hero.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', visibility);
    Promise.all([imageReady(robotImage.current), imageReady(dogImage.current)]).then(() => {
      if (disposed) return;
      s.ready = true; s.last = 0; paint(1); readyCallback.current?.(true);
    }).catch(() => { if (!disposed) readyCallback.current?.(false, true); });
    frame = requestAnimationFrame(animate);
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); imageListenerCleanup.forEach(cleanup => cleanup()); hero.removeEventListener('pointermove', pointer); hero.removeEventListener('pointerleave', leave); document.removeEventListener('visibilitychange', visibility); render.current = () => {}; };
  }, [host, robot?.src, dog?.src]);
  const position = (image?: ImageSlot): CSSProperties => ({ '--slot-x': `${(image?.positionX ?? 50) - 50}%`, '--slot-y': `${(image?.positionY ?? 50) - 50}%`, '--slot-scale': image?.scale ?? 1 } as CSSProperties);
  const imageDescription = mode === 'labrador' ? dog?.alt || '视障人士与拉布拉多导盲犬一起前行。' : mode === 'robot' ? robot?.alt || '视障人士与 AI 机器狗一起前行。' : '拉布拉多导盲犬通过流动画面转变为 AI 机器狗。';
  return <div className="ss-liquid" data-liquid-mode={mode} role={playback ? 'img' : undefined} aria-label={playback ? imageDescription : undefined}>
    <svg className="ss-filter-defs" aria-hidden="true"><defs><filter id={id} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.012" numOctaves="2" seed="7" result="noise"/><feDisplacementMap ref={displacement} in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>
    <svg ref={ribbon} className="ss-ribbon" aria-hidden="true" preserveAspectRatio="none"><path ref={fill} className="ss-ribbon-fill"/><path ref={top} className="ss-ribbon-top"/><path ref={bottom} className="ss-ribbon-bottom"/></svg>
    <div ref={robotLayer} className="ss-portrait ss-scene-robot" aria-hidden={playback ? true : undefined}><img ref={robotImage} className="ss-subject" src={robot?.src} alt={mode === 'labrador' ? dog?.alt : robot?.alt} fetchPriority="high" draggable={false} style={position(robot)}/></div>
    <div ref={dogLayer} className="ss-portrait ss-scene-labrador" aria-hidden="true"><img ref={dogImage} className="ss-subject" src={dog?.src} alt="" draggable={false} style={{ ...position(dog), filter: `url(#${id})` }}/></div>
  </div>;
}
