import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoFrameClock } from '../lib/demo-frame-clock.ts';

test('30–240 Hz displays render at up to 60 fps while retaining elapsed animation time', () => {
  for (const refreshRate of [30, 60, 90, 120, 144, 240]) {
    const clock = createDemoFrameClock();
    let rendered = 0;
    let elapsed = 0;
    let lastRendered = 0;
    for (let frame = 0; frame <= refreshRate * 3; frame += 1) {
      const now = frame * 1000 / refreshRate;
      const delta = clock.tick(now);
      if (delta === null) continue;
      rendered += 1;
      elapsed += delta;
      lastRendered = now;
    }
    assert.ok(Math.abs(rendered - (Math.min(60, refreshRate) * 3 + 1)) <= 1, `${refreshRate} Hz: ${rendered} frames`);
    assert.ok(Math.abs(elapsed - lastRendered / 1000) < 1e-8, `${refreshRate} Hz must not speed up or slow down animation`);
  }
});

test('rounded/jittered high-refresh timestamps do not halve the intended render rate', () => {
  const clock = createDemoFrameClock();
  let rendered = 0;
  for (let frame = 0; frame <= 1200; frame += 1) {
    const now = Math.round((frame * 1000 / 120 + (frame % 3 - 1) * 0.08) * 10) / 10;
    if (clock.tick(now) !== null) rendered += 1;
  }
  assert.ok(rendered >= 599 && rendered <= 602, `${rendered} frames in 10 seconds`);
});

test('resuming visibility resets visual delta instead of replaying hidden time', () => {
  const clock = createDemoFrameClock();
  clock.tick(0);
  clock.tick(1000 / 60);
  clock.reset();
  assert.equal(clock.tick(60000), 0);
  assert.equal(clock.tick(60001), null);
  assert.ok(Math.abs(clock.tick(60000 + 1000 / 60) - 1 / 60) < 1e-8);
});

test('a long visible stall renders once with bounded delta, never a catch-up burst', () => {
  const clock = createDemoFrameClock();
  clock.tick(0);
  assert.equal(clock.tick(5000), 0.08);
  assert.equal(clock.tick(5000), null);
  assert.equal(clock.tick(5001), null);
  assert.ok(clock.tick(5000 + 1000 / 60) > 0);
});
