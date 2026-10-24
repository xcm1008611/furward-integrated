import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { GUIDE_FOLLOW_DISTANCE_M, navigationForState, pointAtDistance, worldToMapPoint } from '../lib/demo-types.ts';

const world = JSON.parse(await readFile(new URL('../../shared/route.json', import.meta.url), 'utf8'));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// A real arc-length detour fixture on the delivered city, with a fixed obstacle.
const original = world.route.points;
const a = pointAtDistance(original, 10).point;
const b = pointAtDistance(original, 14).point;
const heading = pointAtDistance(original, 10).heading;
const side = { ...b, x: b.x + Math.cos(heading) * 2, z: b.z - Math.sin(heading) * 2 };
const end = pointAtDistance(original, 18).point;
const points = [original[0], a, side, end, ...original.slice(1)];
const total = points.slice(1).reduce((sum, point, i) => sum + distance(point, points[i]), 0);
const extra = total - world.route.total_distance_m;
const navigation = { points, total_distance_m: total, step_end_distances: world.route.steps.map(step => step.end_m + extra) };
const obstacle = { id: 'fixed-1', point: pointAtDistance(original, 15).point, heading };
const state = (overrides = {}) => ({ session_id: 'detour-test', revision: 1, status: 'PAUSED', distance_m: 10, current_step: 0,
  pause_reason: 'obstacle', obstacle_active: true, obstacle_triggered: true, message: '前方有障碍，请绕行。',
  navigation, obstacles: [obstacle], detour_until_m: null, ...overrides });

test('world-to-map transform matches all delivered 2D route nodes and preserves metre scale', () => {
  original.forEach((point, i) => worldToMapPoint(point, world.transform).forEach((value, axis) => near(value, world.map.route[i][axis])));
  const pa = worldToMapPoint(a, world.transform), ps = worldToMapPoint(side, world.transform);
  near(Math.hypot(pa[0] - ps[0], pa[1] - ps[1]), distance(a, side));
});

test('map and progress select the replanned arc length, including the follower position', () => {
  const snapshot = state({ distance_m: 14 });
  assert.equal(navigationForState(world, snapshot), navigation);
  assert.ok(navigation.total_distance_m > world.route.total_distance_m);
  const dog = pointAtDistance(navigation.points, snapshot.distance_m).point;
  const human = pointAtDistance(navigation.points, snapshot.distance_m - GUIDE_FOLLOW_DISTANCE_M, true).point;
  assert.ok(distance(dog, pointAtDistance(original, snapshot.distance_m).point) > 1);
  near(distance(dog, human), GUIDE_FOLLOW_DISTANCE_M);
  assert.deepEqual(navigationForState(world, null).points, original);
  near(distance(pointAtDistance(navigation.points, total + 10).point, original.at(-1)), 0);
});

// Render the actual component with only session/network and lifecycle hooks replaced.
// This checks the controls and SVG use the same navigation snapshot, without a GPU.
const runtimeKey = Symbol.for('furward.detour.ui.test');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hooksUrl = moduleUrl(`
  export const useState = value => [typeof value === 'function' ? value() : value, () => {}];
  export const useRef = value => ({ current: value });
  export const useEffect = () => {};
  export const useCallback = value => value;
`);
const sessionUrl = moduleUrl(`export const useDemoSession = () => globalThis[Symbol.for('furward.detour.ui.test')];`);
const source = await readFile(new URL('../app/experience/Experience.tsx', import.meta.url), 'utf8');
let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const replacements = {
  'react/jsx-runtime': new URL('../node_modules/react/jsx-runtime.js', import.meta.url).href,
  react: hooksUrl,
  'next/link': moduleUrl(`export default 'a';`),
  'next/dynamic': moduleUrl('export default () => () => null;'),
  'lucide-react': moduleUrl('export const ArrowLeft=()=>null,ArrowUpRight=()=>null,Volume2=()=>null,VolumeX=()=>null,Send=()=>null,RotateCcw=()=>null,Pause=()=>null,Play=()=>null,Square=()=>null,ArrowRight=()=>null,Check=()=>null;'),
  '@/lib/demo-session': sessionUrl,
  '@/lib/demo-types': new URL('../lib/demo-types.ts', import.meta.url).href,
  './speech': new URL('../app/experience/speech.ts', import.meta.url).href,
  './experience.module.css': moduleUrl('export default new Proxy({}, {get: (_, key) => key});'),
};
for (const [name, replacement] of Object.entries(replacements)) code = code.replaceAll(`from '${name}'`, `from ${JSON.stringify(replacement)}`).replaceAll(`from "${name}"`, `from ${JSON.stringify(replacement)}`);
const { default: Experience } = await import(moduleUrl(code));
const nodes = (tree, predicate) => {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
};
const label = tree => Array.isArray(tree) ? tree.map(label).join('') : typeof tree === 'string' ? tree : tree?.props ? label(tree.props.children) : '';
const button = (tree, text) => nodes(tree, node => node.type === 'button' && label(node) === text)[0];
function mount(t, snapshot, { busy = false, pending = false } = {}) {
  const calls = [];
  let finish;
  globalThis[runtimeKey] = { world, state: snapshot, stateRef: { current: snapshot }, receivedAt: { current: 0 },
    connection: 'online', busy, error: '', notice: '', retry() {}, sendText() {},
    action(action) { calls.push(action); return pending ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(snapshot); } };
  t.after(() => { delete globalThis[runtimeKey]; });
  return { tree: Experience(), calls, finish: () => finish?.(snapshot) };
}

test('waiting obstacle offers bypass and rapid primary/auxiliary clicks cannot duplicate it', async t => {
  const ui = mount(t, state(), { pending: true });
  const primary = button(ui.tree, '绕行前进'), bypass = button(ui.tree, '绕行障碍');
  assert.equal(primary.props['aria-disabled'], false);
  assert.equal(bypass.props['aria-disabled'], false);
  bypass.props.onClick();
  primary.props.onClick();
  bypass.props.onClick();
  assert.deepEqual(ui.calls, ['obstacle_bypass']);
  ui.finish();
  await Promise.resolve();
  assert.ok(!renderToStaticMarkup(ui.tree).includes('清除障碍'));
});

test('paused detour remains resumable but cannot add another obstacle; map retains obstacle and both characters', t => {
  const ui = mount(t, state({ obstacle_active: false, pause_reason: 'user', detour_until_m: 22, distance_m: 14 }));
  button(ui.tree, '继续前进').props.onClick();
  const blocked = button(ui.tree, '绕行中');
  assert.equal(blocked.props['aria-disabled'], true);
  blocked.props.onClick();
  assert.deepEqual(ui.calls, ['resume']);
  const markup = renderToStaticMarkup(ui.tree);
  for (const marker of ['data-map-obstacle="fixed-1"', 'data-map-character="human"', 'data-map-character="dog"', '含绕行', '绕行已暂停']) assert.ok(markup.includes(marker), marker);
  const progress = nodes(ui.tree, node => node.props?.role === 'progressbar')[0];
  assert.equal(progress.props['aria-valuemax'], total);
  assert.equal(progress.props['aria-valuenow'], 14);
});

test('step completion waits for its new detour boundary instead of the original endpoint', t => {
  const ui = mount(t, state({ status: 'ACTIVE', obstacle_active: false, distance_m: world.route.steps[0].end_m + extra / 2 }));
  const first = nodes(ui.tree, node => node.type === 'li')[0];
  assert.equal(first.props['data-complete'], false);
  assert.equal(first.props['aria-current'], 'step');
});
