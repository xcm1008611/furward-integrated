/** Limit expensive scene work without tying animation time to display refresh rate. */
export function createDemoFrameClock() {
  const interval = 1000 / 60;
  let nextFrameAt: number | null = null;
  let lastRenderedAt: number | null = null;

  return {
    tick(now: number): number | null {
      // Browser timestamps can be rounded; tolerate a fraction of a millisecond.
      if (nextFrameAt !== null && now + 0.15 < nextFrameAt) return null;
      const delta = lastRenderedAt === null ? 0 : Math.min(Math.max(0, now - lastRenderedAt) / 1000, 0.08);
      if (nextFrameAt === null) nextFrameAt = now + interval;
      else nextFrameAt += (Math.max(0, Math.floor((now + 0.15 - nextFrameAt) / interval)) + 1) * interval;
      lastRenderedAt = now;
      return delta;
    },
    reset() {
      nextFrameAt = null;
      lastRenderedAt = null;
    },
  };
}
