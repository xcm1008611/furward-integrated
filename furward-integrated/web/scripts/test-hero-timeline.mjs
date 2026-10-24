import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { advanceHeroTime, getHeroFrame, HERO_DURATION } from '../app/components/hero-timeline.ts';

test('one play holds the dog, shows the liquid view, and settles fully on the robot', () => {
  assert.equal(getHeroFrame(0).fullDog, true);
  assert.equal(getHeroFrame(.6).fullDog, true);
  assert.equal(getHeroFrame(2).stage, 'flow');
  assert.ok(getHeroFrame(2).amplitude > 0);
  const end = getHeroFrame(6);
  assert.equal(end.stage, 'robot');
  assert.equal(end.complete, true);
  assert.equal(end.half, 0);
  assert.equal(end.amplitude, 0);
  assert.deepEqual(getHeroFrame(100), end);
});

test('liquid geometry remains continuous at every sequence boundary', () => {
  for (const boundary of [.6, 1.8, 4.5, 6]) {
    const before = getHeroFrame(boundary - .000001);
    const after = getHeroFrame(boundary + .000001);
    for (const key of ['half', 'center', 'amplitude']) assert.ok(Math.abs(after[key] - before[key]) < .00001, `${key} jumps at ${boundary}`);
  }
});

test('pauses, hidden pages, and unloaded images consume no sequence time', () => {
  const before = getHeroFrame(2.75);
  for (const reason of ['paused', 'hidden', 'loading']) {
    const held = advanceHeroTime(2.75, 30, false, false);
    assert.deepEqual(getHeroFrame(held), before, reason);
    assert.equal(advanceHeroTime(held, .25, true, false), 3);
  }
});

test('elapsed time and completion do not depend on frame rate', () => {
  for (const rate of [20, 60, 120]) {
    let elapsed = 0;
    for (let frame = 0; frame < rate * 7; frame++) elapsed = advanceHeroTime(elapsed, 1 / rate, true, false);
    assert.equal(elapsed, HERO_DURATION);
    assert.equal(getHeroFrame(elapsed).complete, true);
  }
  assert.equal(advanceHeroTime(5.9, 5, true, false), 6);
});

test('reduced motion uses a 200ms fade with exact endpoints', () => {
  assert.equal(getHeroFrame(0, true).fade, 0);
  assert.equal(getHeroFrame(.1, true).fade, .5);
  assert.equal(getHeroFrame(.2, true).fade, 1);
  assert.equal(getHeroFrame(.2, true).complete, true);
  assert.equal(advanceHeroTime(0, 1, true, true), .2);
});

// Run the component's actual effects and RAF callback against a tiny DOM/hook
// harness. This catches lifecycle bugs that a geometry-only test cannot cover.
const runtimeKey = Symbol.for('furward.hero.test.runtime');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hooksUrl = moduleUrl(`
  const runtime = () => globalThis[Symbol.for('furward.hero.test.runtime')];
  export const useRef = value => runtime().useRef(value);
  export const useEffect = (effect, deps) => runtime().useEffect(effect, deps);
  export const useId = () => 'test-hero';
`);
const jsxUrl = moduleUrl('export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;');
const timelineSource = await readFile(new URL('../app/components/hero-timeline.ts', import.meta.url), 'utf8');
const timelineUrl = moduleUrl(ts.transpileModule(timelineSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const componentSource = await readFile(new URL('../app/components/FurwardLiquid.tsx', import.meta.url), 'utf8');
const imports = { react: hooksUrl, 'react/jsx-runtime': jsxUrl, './hero-timeline': timelineUrl };
const componentCode = ts.transpileModule(componentSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/from\s+(['"])([^'"]+)\1/g, (whole, _quote, name) => imports[name] ? `from ${JSON.stringify(imports[name])}` : whole);
const { default: FurwardLiquid } = await import(moduleUrl(componentCode));

async function mountHero(t, reducedMotion = false, imageState = 'ready') {
  const refs = [], effects = [], pending = [], nodes = new Map(), frames = new Map(), listeners = new Map(), images = [], readiness = [];
  let refIndex = 0, effectIndex = 0, nextFrame = 0, resize, completed = 0, tree;
  const stages = [];
  const makeElement = () => {
    const events = new Map();
    return {
      style: { setProperty(key, value) { this[key] = value; } }, attributes: {}, complete: imageState !== 'pending', naturalWidth: imageState === 'ready' ? 1536 : 0,
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, listener) { events.set(name, listener); }, removeEventListener(name) { events.delete(name); },
      emit(name) { events.get(name)?.(); },
    };
  };
  const host = { ...makeElement(), clientWidth: 1400, clientHeight: 800 };
  let props = { host: { current: host }, mode: 'labrador', playback: { status: 'idle', runId: 0, reducedMotion }, onReady: (loaded, failed) => readiness.push([loaded, !!failed]), onComplete: () => completed++, onStageChange: stage => stages.push(stage) };
  const original = new Map(['document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, globalThis[name]]));
  globalThis.document = { hidden: false, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) };
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis[runtimeKey] = {
    useRef(value) { const index = refIndex++; return refs[index] ||= { current: value }; },
    useEffect(effect, deps) {
      const index = effectIndex++, previous = effects[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) pending.push(() => {
        previous?.cleanup?.(); effects[index] = { deps, cleanup: effect() };
      });
    },
  };
  function connect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(connect); return; }
    if (node.props?.ref) {
      if (!node.props.ref.current) {
        node.props.ref.current = makeElement();
        if (node.type === 'img') images.push(node.props.ref.current);
      }
      if (node.props.className) nodes.set(node.props.className, node.props.ref.current);
    }
    connect(node.props?.children);
  }
  function render(status, runId = props.playback?.runId ?? 0) {
    if (status) props = { ...props, playback: { ...props.playback, status, runId } };
    refIndex = 0; effectIndex = 0; tree = FurwardLiquid(props); connect(tree);
    pending.splice(0).forEach(effect => effect());
  }
  const picture = () => Object.fromEntries(['ss-portrait ss-scene-robot', 'ss-portrait ss-scene-labrador', 'ss-ribbon', 'ss-ribbon-fill'].map(name => {
    const node = nodes.get(name);
    return [name, { ...node.style, setProperty: undefined, ...node.attributes }];
  }));
  t.after(() => {
    effects.forEach(effect => effect?.cleanup?.());
    for (const [name, value] of original) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; }
    delete globalThis[runtimeKey];
  });
  render();
  await new Promise(resolve => setImmediate(resolve));
  return {
    render, picture, nodes, stages, readiness, completed: () => completed, tree: () => tree,
    preference(reducedMotion) { props = { ...props, playback: { ...props.playback, reducedMotion } }; render(); },
    mode(mode) { props = { ...props, mode }; render(); },
    legacy(mode = props.mode, paused = false) { props = { ...props, playback: undefined, mode, paused }; render(); },
    pauseLegacy(paused) { props = { ...props, paused }; render(); },
    async loadImage(index, success = true) {
      images[index].complete = true; images[index].naturalWidth = success ? 1536 : 0; images[index].emit(success ? 'load' : 'error');
      await new Promise(resolve => setImmediate(resolve));
    },
    tick(now) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); },
    visibility(hidden) { document.hidden = hidden; listeners.get('visibilitychange')?.(); },
    resize(height) { host.clientHeight = height; resize(); },
  };
}

test('component pause and resume preserve the exact current picture', async t => {
  const hero = await mountHero(t);
  hero.render('playing', 1); hero.tick(1000); hero.tick(3500);
  const before = hero.picture();
  hero.render('paused'); hero.tick(8000);
  assert.deepEqual(hero.picture(), before);
  hero.render('playing'); hero.tick(8016);
  assert.deepEqual(hero.picture(), before);
  hero.tick(8032);
  assert.notDeepEqual(hero.picture(), before);
});

test('component freezes hidden time and retains progress through resizing', async t => {
  const hero = await mountHero(t);
  hero.render('playing', 1); hero.tick(1000); hero.tick(3000);
  const before = hero.picture();
  hero.visibility(true); hero.tick(9000);
  hero.visibility(false); hero.tick(9016);
  assert.deepEqual(hero.picture(), before);
  hero.resize(1000);
  assert.notDeepEqual(hero.picture(), before);
  hero.resize(800);
  assert.deepEqual(hero.picture(), before);
  assert.equal(hero.stages.at(-1), 'flow');
  hero.tick(9032);
  assert.notDeepEqual(hero.picture(), before);
});

test('component finishes once, hides the dog and ribbon, then replays from the dog', async t => {
  const hero = await mountHero(t);
  hero.render('playing', 1); hero.tick(1000); hero.tick(7000); hero.tick(8000);
  assert.equal(hero.completed(), 1);
  assert.equal(hero.nodes.get('ss-portrait ss-scene-labrador').style.visibility, 'hidden');
  assert.equal(hero.nodes.get('ss-ribbon').style.visibility, 'hidden');
  hero.render('playing', 2);
  assert.equal(hero.nodes.get('ss-portrait ss-scene-robot').style.visibility, 'hidden');
  assert.equal(hero.nodes.get('ss-portrait ss-scene-labrador').style.opacity, '1');
  assert.equal(hero.stages.at(-1), 'labrador');
  hero.tick(9000); hero.tick(15000);
  assert.equal(hero.completed(), 2);
});

test('component reduced-motion fade remains pausable and completes across frames', async t => {
  const hero = await mountHero(t, true);
  hero.render('playing', 1); hero.tick(1000); hero.tick(1100);
  assert.equal(hero.nodes.get('ss-portrait ss-scene-labrador').style.opacity, '0.5');
  const middle = hero.picture();
  hero.render('paused'); hero.tick(2000);
  assert.deepEqual(hero.picture(), middle);
  hero.render('playing'); hero.tick(2016); hero.tick(2116);
  assert.equal(hero.completed(), 1);
  assert.equal(hero.nodes.get('ss-portrait ss-scene-labrador').style.visibility, 'hidden');
});

test('enabling reduced motion while paused preserves this run and applies to replay', async t => {
  const hero = await mountHero(t);
  hero.render('playing', 1); hero.tick(1000); hero.tick(3500); hero.render('paused');
  const paused = hero.picture();
  hero.preference(true);
  assert.deepEqual(hero.picture(), paused);
  hero.render('playing'); hero.tick(4000); hero.tick(4100);
  assert.equal(hero.completed(), 0);
  hero.tick(7500);
  assert.equal(hero.completed(), 1);
  hero.render('playing', 2); hero.tick(8000); hero.tick(8100);
  assert.equal(hero.nodes.get('ss-portrait ss-scene-labrador').style.opacity, '0.5');
  hero.tick(8200);
  assert.equal(hero.completed(), 2);
});

test('disabling reduced motion while paused preserves the fade and changes the next run', async t => {
  const hero = await mountHero(t, true);
  hero.render('playing', 1); hero.tick(1000); hero.tick(1100); hero.render('paused');
  const paused = hero.picture();
  hero.preference(false);
  assert.deepEqual(hero.picture(), paused);
  hero.render('playing'); hero.tick(2000); hero.tick(2100);
  assert.equal(hero.completed(), 1);
  hero.render('playing', 2); hero.tick(3000); hero.tick(3200);
  assert.equal(hero.nodes.get('ss-portrait ss-scene-labrador').style.opacity, '1');
  assert.equal(hero.completed(), 1);
  hero.tick(9000);
  assert.equal(hero.completed(), 2);
});

test('homepage exposes one stage description while preserving legacy image semantics', async t => {
  const hero = await mountHero(t);
  assert.equal(hero.tree().props.role, 'img');
  assert.match(hero.tree().props['aria-label'], /拉布拉多/);
  const robotLayer = () => hero.tree().props.children.find(node => node.props?.className === 'ss-portrait ss-scene-robot');
  assert.equal(robotLayer().props['aria-hidden'], true);
  hero.mode('flow');
  assert.match(hero.tree().props['aria-label'], /流动画面/);
  hero.mode('robot');
  assert.match(hero.tree().props['aria-label'], /AI 机器狗/);
  hero.legacy();
  assert.equal(hero.tree().props.role, undefined);
  assert.equal(hero.tree().props['aria-label'], undefined);
  assert.equal(robotLayer().props['aria-hidden'], undefined);
});

test('component waits for both images and excludes their loading delay from playback', async t => {
  const hero = await mountHero(t, false, 'pending');
  hero.render('playing', 1); hero.tick(1000); hero.tick(5000);
  assert.deepEqual(hero.readiness, [[false, false]]);
  assert.equal(hero.stages.length, 0);
  await hero.loadImage(0);
  assert.deepEqual(hero.readiness, [[false, false]]);
  hero.tick(6000);
  await hero.loadImage(1);
  assert.deepEqual(hero.readiness, [[false, false], [true, false]]);
  hero.tick(10000); hero.tick(10500);
  assert.equal(hero.stages.at(-1), 'labrador');
  assert.equal(hero.completed(), 0);
  hero.tick(12000);
  assert.equal(hero.stages.at(-1), 'flow');
  hero.tick(16000);
  assert.equal(hero.completed(), 1);
});

test('image errors report failure without advancing or completing the sequence', async t => {
  const hero = await mountHero(t, false, 'pending');
  hero.render('playing', 1); hero.tick(1000);
  await hero.loadImage(0, false);
  await hero.loadImage(1);
  hero.tick(10000);
  assert.deepEqual(hero.readiness, [[false, false], [false, true]]);
  assert.equal(hero.stages.length, 0);
  assert.equal(hero.completed(), 0);
});

test('legacy preview retains all four modes and can pause its continuous flow', async t => {
  const hero = await mountHero(t);
  hero.legacy('labrador', true);
  const dogPath = hero.nodes.get('ss-ribbon-fill').attributes.d;
  assert.match(dogPath, /^M/);
  hero.legacy('robot', true);
  const robotPath = hero.nodes.get('ss-ribbon-fill').attributes.d;
  assert.notEqual(robotPath, dogPath);
  const robotY = [...robotPath.matchAll(/[-\d.]+,([-\d.]+)/g)].map(match => Number(match[1]));
  assert.equal(new Set(robotY).size, 1);
  hero.legacy('overlay', true);
  assert.equal(hero.nodes.get('ss-portrait ss-scene-robot').style.clipPath, 'none');
  assert.equal(hero.nodes.get('ss-portrait ss-scene-labrador').style.clipPath, 'none');
  assert.equal(hero.nodes.get('ss-portrait ss-scene-robot').style.opacity, '.5');
  assert.equal(hero.nodes.get('ss-portrait ss-scene-labrador').style.opacity, '.5');
  assert.equal(hero.nodes.get('ss-ribbon').style.visibility, 'hidden');
  hero.legacy('flow'); hero.tick(1000); hero.tick(2000);
  assert.equal(hero.nodes.get('ss-ribbon').style.visibility, 'visible');
  hero.pauseLegacy(true);
  const paused = hero.picture();
  hero.tick(8000);
  assert.deepEqual(hero.picture(), paused);
  hero.pauseLegacy(false); hero.tick(8100);
  assert.notDeepEqual(hero.picture(), paused);
  assert.equal(hero.completed(), 0);
});
