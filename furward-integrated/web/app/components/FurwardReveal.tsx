'use client';

import { useEffect, useId, useRef } from 'react';
import type { ImageSlot } from '@/lib/content';
import styles from './FurwardReveal.module.css';

export type RevealMode = 'dog' | 'robot' | 'overlay' | 'play';
type Props = { dog?: ImageSlot; robot?: ImageSlot; previewMode?: RevealMode; replayKey?: number; onComplete?: () => void };

/** One continuous wave advances completely beyond the canvas: no looping ribbon remains. */
function wavePath(progress: number) {
  const edge = -240 + 2016 * progress;
  const amplitude = Math.sin(Math.PI * progress) * 100;
  let path = 'M -300 -20';
  for (let y = -20; y <= 1060; y += 20) {
    const x = edge + Math.sin(y / 165 + progress * 6) * amplitude + Math.sin(y / 78 - progress * 8) * amplitude * .22;
    path += ` L ${x.toFixed(2)} ${y}`;
  }
  return path + ' L -300 1060 Z';
}

export default function FurwardReveal({ dog, robot, previewMode = 'dog', replayKey = 0, onComplete }: Props) {
  const id = useId().replace(/:/g, '');
  const path = useRef<SVGPathElement>(null);
  const dogLayer = useRef<SVGGElement>(null);
  const robotLayer = useRef<SVGGElement>(null);
  const onDone = useRef(onComplete);
  onDone.current = onComplete;
  useEffect(() => {
    let frame = 0;
    let disposed = false;
    const paint = (progress: number) => {
      path.current?.setAttribute('d', wavePath(progress));
      if (dogLayer.current) dogLayer.current.style.opacity = progress >= 1 ? '0' : '1';
      if (robotLayer.current) robotLayer.current.style.clipPath = progress >= 1 ? 'none' : `url(#${id})`;
    };
    if (previewMode === 'play') {
      if (robotLayer.current) robotLayer.current.style.opacity = '1';
      paint(0);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) { paint(1); onDone.current?.(); }
      else {
        const start = performance.now();
        const animate = (now: number) => {
          if (disposed) return;
          const t = Math.min(1, (now - start) / 1800);
          const progress = t * t * (3 - 2 * t);
          paint(progress);
          if (t < 1) frame = requestAnimationFrame(animate);
          else onDone.current?.();
        };
        frame = requestAnimationFrame(animate);
      }
    } else {
      if (dogLayer.current) dogLayer.current.style.opacity = previewMode === 'robot' ? '0' : previewMode === 'overlay' ? '.5' : '1';
      if (robotLayer.current) { robotLayer.current.style.clipPath = previewMode === 'dog' ? `url(#${id})` : 'none'; robotLayer.current.style.opacity = previewMode === 'overlay' ? '.5' : '1'; }
      path.current?.setAttribute('d', wavePath(0));
    }
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, [previewMode, replayKey, id]);
  const transform = (slot?: ImageSlot) => `translate(${((slot?.positionX ?? 50) - 50) * 15.36} ${((slot?.positionY ?? 50) - 50) * 10.24}) translate(768 512) scale(${slot?.scale ?? 1}) translate(-768 -512)`;
  return <svg className={styles.canvas} viewBox="0 0 1536 1024" role="img" aria-label={previewMode === 'robot' ? robot?.alt || '人物与机器狗' : previewMode === 'play' ? '流动转场：拉布拉多变为机器狗' : dog?.alt || '人物与拉布拉多'}>
    <defs><clipPath id={id} clipPathUnits="userSpaceOnUse"><path ref={path} d={wavePath(0)}/></clipPath></defs>
    <g ref={dogLayer} style={{ opacity: previewMode === 'robot' ? 0 : previewMode === 'overlay' ? .5 : 1 }}><image href={dog?.src} width="1536" height="1024" preserveAspectRatio="xMidYMid meet" transform={transform(dog)}/></g>
    <g ref={robotLayer} style={{ opacity: previewMode === 'overlay' ? .5 : 1, clipPath: previewMode === 'robot' || previewMode === 'overlay' ? 'none' : `url(#${id})` }}><image href={robot?.src} width="1536" height="1024" preserveAspectRatio="xMidYMid meet" transform={transform(robot)}/></g>
  </svg>;
}
