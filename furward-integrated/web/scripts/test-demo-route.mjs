import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pointAtDistance, angleDifference } from '../lib/demo-types.ts';

const world = JSON.parse(await readFile(new URL('../../shared/route.json', import.meta.url), 'utf8'));
const { points, total_distance_m: total, steps } = world.route;
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 0.001, `${message}: ${a} vs ${b}`);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
near(points.slice(1).reduce((sum, point, i) => sum + distance(point, points[i]), 0), total, 'World route must equal server distance');
assert.deepEqual(pointAtDistance(points, 0).point, points[0]);
near(distance(pointAtDistance(points, total + 20).point, points.at(-1)), 0, 'Cannot pass destination');
assert.deepEqual(pointAtDistance(points, -5).point, points[0]);
near(distance(pointAtDistance(points, -2.2, true).point, points[0]), 2.2, 'Human starts behind dog without overlapping');
for (const step of steps.slice(0, -1)) {
  const before = pointAtDistance(points, step.end_m - 0.0001);
  const after = pointAtDistance(points, step.end_m + 0.0001);
  assert.ok(distance(before.point, after.point) < 0.001, 'Turning must not teleport');
  near(Math.abs(angleDifference(after.heading, before.heading)), Math.PI / 2, 'Every existing turn is a right angle');
  const dog = pointAtDistance(points, step.end_m + 1.1).point;
  const human = pointAtDistance(points, step.end_m - 1.1).point;
  assert.ok(distance(dog, human) > 1.5, 'Human and dog stay apart around corners');
}
near(angleDifference(-Math.PI + 0.01, Math.PI - 0.01), 0.02, 'Heading crosses ±π via the short turn');
console.log('PASS: shared 150m route, endpoints, following separation, continuous corners, headings.');
