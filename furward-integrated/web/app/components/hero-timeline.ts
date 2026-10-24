export type HeroPlaybackStatus = 'idle' | 'playing' | 'paused' | 'finished';
export type HeroStage = 'labrador' | 'flow' | 'robot';

export const HERO_DURATION = 6;
export const REDUCED_HERO_DURATION = .2;

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

/** Seconds of visible, loaded playback; paused and hidden frames consume no time. */
export function advanceHeroTime(elapsed: number, delta: number, active: boolean, reducedMotion: boolean) {
  const duration = reducedMotion ? REDUCED_HERO_DURATION : HERO_DURATION;
  return clamp(elapsed + (active ? Math.max(0, delta) : 0), 0, duration);
}

/** Geometry is normalized to the hero height, so resizing cannot reset the sequence. */
export function getHeroFrame(elapsed: number, reducedMotion = false) {
  const duration = reducedMotion ? REDUCED_HERO_DURATION : HERO_DURATION;
  const seconds = clamp(elapsed, 0, duration);
  const complete = seconds >= duration;
  const time = 7 + seconds;
  const entering = smoothstep((seconds - .6) / 1.2);
  const leaving = 1 - smoothstep((seconds - 4.5) / 1.5);
  const flowWeight = entering * leaving;
  const autoHalf = .19 + .045 * Math.sin(time * .37);
  const stage: HeroStage = complete ? 'robot' : reducedMotion ? seconds === 0 ? 'labrador' : 'flow' : seconds < .6 ? 'labrador' : seconds < 4.5 ? 'flow' : 'robot';
  return {
    stage,
    complete,
    time,
    fullDog: reducedMotion ? seconds === 0 : seconds <= .6,
    half: (1.8 + (autoHalf - 1.8) * entering) * leaving,
    center: .66 + .15 * Math.sin(time * .25),
    amplitude: .055 * flowWeight,
    flowWeight,
    fade: smoothstep(seconds / REDUCED_HERO_DURATION),
  };
}
