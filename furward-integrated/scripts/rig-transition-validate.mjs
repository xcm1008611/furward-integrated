#!/usr/bin/env node
/** Real THREE.AnimationMixer + exported skins + production foot constraint.
 * Run with Node 24: node scripts/rig-transition-validate.mjs
 * Deliberately exercises interpolated crossfades, not only authored clip frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from '../web/node_modules/three/build/three.module.js';
import { collectFootContacts, groundFootContacts, restoreFootContacts } from '../web/lib/foot-contact.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web/public/city/animated');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'rig-manifest.json')));
const SPEED = 1.2, FADE = .22;
const read = kind => {
  const glb = fs.readFileSync(path.join(OUT, kind + '.glb'));
  const jsonLength = glb.readUInt32LE(12);
  return { gltf: JSON.parse(glb.toString('utf8', 20, 20 + jsonLength)), bin: glb.subarray(28 + jsonLength) };
};
function loadRig(kind) {
  const { gltf: g, bin } = read(kind);
  function accessor(index) {
    const a = g.accessors[index], view = g.bufferViews[a.bufferView];
    const C = { 5126: Float32Array, 5123: Uint16Array, 5121: Uint8Array, 5125: Uint32Array }[a.componentType];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    assert(!view.byteStride, 'Fixture must support strided accessors before accepting this asset');
    const offset = (view.byteOffset || 0) + (a.byteOffset || 0);
    const bytes = bin.subarray(offset, offset + a.count * size * C.BYTES_PER_ELEMENT);
    return { array: new C(Uint8Array.from(bytes).buffer), size };
  }
  const joints = new Set(g.skins.flatMap(s => s.joints));
  const nodes = g.nodes.map((n, i) => {
    let o;
    if (n.mesh !== undefined) {
      const p = g.meshes[n.mesh].primitives[0], geom = new THREE.BufferGeometry();
      for (const [attr, name] of [['POSITION', 'position'], ['JOINTS_0', 'skinIndex'], ['WEIGHTS_0', 'skinWeight']]) {
        const a = accessor(p.attributes[attr]); geom.setAttribute(name, new THREE.BufferAttribute(a.array, a.size));
      }
      o = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial());
    } else o = joints.has(i) ? new THREE.Bone() : new THREE.Group();
    o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  g.nodes.forEach((n, i) => n.children?.forEach(c => nodes[i].add(nodes[c])));
  const root = new THREE.Group(); g.scenes[g.scene || 0].nodes.forEach(i => root.add(nodes[i]));
  root.updateMatrixWorld(true);
  g.nodes.forEach((n, i) => {
    if (n.skin === undefined) return;
    const s = g.skins[n.skin], inverse = accessor(s.inverseBindMatrices).array;
    const skeleton = new THREE.Skeleton(s.joints.map(j => nodes[j]), s.joints.map((_, j) => new THREE.Matrix4().fromArray(inverse, j * 16)));
    nodes[i].bind(skeleton, nodes[i].matrixWorld);
  });
  const mixer = new THREE.AnimationMixer(root), actions = {};
  for (const animation of g.animations) {
    const tracks = animation.channels.map(c => {
      const sampler = animation.samplers[c.sampler], input = accessor(sampler.input).array, output = accessor(sampler.output).array;
      assert.equal(sampler.interpolation, 'LINEAR');
      const field = { rotation: 'quaternion', translation: 'position', scale: 'scale' }[c.target.path];
      const Track = c.target.path === 'rotation' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
      return new Track(nodes[c.target.node].name + '.' + field, input, output);
    });
    const action = mixer.clipAction(new THREE.AnimationClip(animation.name, -1, tracks));
    if (animation.name === 'stop') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
    actions[animation.name] = action;
  }
  const feet = collectFootContacts(root);
  assert.equal(feet.length, kind === 'human' ? 2 : 4);
  const meshes = nodes.filter(n => n instanceof THREE.SkinnedMesh);
  return { kind, root, mixer, actions, feet, meshes, current: '', nominal: manifest.models[kind].nominal_walk_speed_mps };
}
function transition(rig, name) {
  const next = rig.actions[name];
  next.reset().setEffectiveTimeScale(name === 'walk' ? SPEED / rig.nominal : 1).setEffectiveWeight(1).play();
  if (rig.current) rig.actions[rig.current].crossFadeTo(next, FADE, false);
  rig.current = name;
}
const round = n => +n.toFixed(8);
const scenarios = [
  { name: 'start', from: 'idle', to: 'walk' },
  { name: 'stop', from: 'walk', to: 'stop' },
  { name: 'resume_during_stop', from: 'stop', to: 'walk' },
  { name: 'left_turn', from: 'walk', to: 'turn_left' },
  { name: 'right_turn', from: 'walk', to: 'turn_right' },
  { name: 'turn_to_idle', from: 'turn_left', to: 'idle' },
];
const groundCases = [
  { name: 'level', floor: () => 0 },
  // Source city has a thin ground/road-height difference, not traversable stairs.
  { name: 'road_edge_12mm', floor: (x, z) => z > .06 ? .012 : 0 },
];
const report = { version: 1, route_speed_mps: SPEED, fade_s: FADE, phases: 16, frame_rates: [60, 120], note: 'Production post-blend solver, exact exported glTF meshes. Clearance is measured on actual skinned vertices, never bone origins.', models: {} };
const point = new THREE.Vector3();
for (const kind of ['human', 'dog']) {
  const results = [];
  for (const scenario of scenarios) for (const ground of groundCases) for (const fps of report.frame_rates) {
    const result = { scenario: scenario.name, ground: ground.name, fps, minimum_before_m: Infinity, minimum_after_m: Infinity, maximum_ankle_lift_m: 0, maximum_correction_change_per_frame_m: 0, maximum_root_correction_m: 0, maximum_bone_length_error_m: 0, maximum_lowest_mesh_clearance_m: 0 };
    for (let phase = 0; phase < report.phases; phase++) {
      const rig = loadRig(kind);
      transition(rig, scenario.from);
      rig.actions[scenario.from].time = phase / report.phases * rig.actions[scenario.from].getClip().duration;
      rig.mixer.update(0);
      transition(rig, scenario.to);
      let previousLift = 0;
      for (let frame = 1; frame <= Math.round(fps * .8); frame++) {
        const time = frame / fps;
        if (rig.current === 'stop' && !rig.actions.stop.isRunning()) transition(rig, 'idle');
        const yaw = scenario.name.includes('turn') ? (1 - Math.exp(-time * 8)) * Math.PI / 2 : .61;
        rig.root.position.set(.2, .003, scenario.to === 'walk' ? time * SPEED : 0);
        rig.root.position.y += ground.floor(rig.root.position.x, rig.root.position.z);
        rig.root.rotation.y = yaw;
        restoreFootContacts(rig.feet);
        rig.mixer.update(1 / fps); rig.root.updateMatrixWorld(true);
        const lengths = rig.feet.map(f => [f.upper.getWorldPosition(new THREE.Vector3()).distanceTo(f.lower.getWorldPosition(new THREE.Vector3())), f.lower.getWorldPosition(new THREE.Vector3()).distanceTo(f.foot.getWorldPosition(new THREE.Vector3()))]);
        function minimum() {
          let min = Infinity;
          for (const mesh of rig.meshes) for (let v = 0; v < mesh.geometry.getAttribute('position').count; v++) {
            mesh.getVertexPosition(v, point); point.applyMatrix4(mesh.matrixWorld);
            min = Math.min(min, point.y - ground.floor(point.x, point.z));
          }
          return min;
        }
        result.minimum_before_m = Math.min(result.minimum_before_m, minimum());
        const rootBefore = rig.root.position.clone();
        const lift = groundFootContacts(rig.feet, ground.floor, 0);
        const after = minimum();
        result.minimum_after_m = Math.min(result.minimum_after_m, after);
        result.maximum_lowest_mesh_clearance_m = Math.max(result.maximum_lowest_mesh_clearance_m, after);
        result.maximum_ankle_lift_m = Math.max(result.maximum_ankle_lift_m, lift);
        if (frame > 1) result.maximum_correction_change_per_frame_m = Math.max(result.maximum_correction_change_per_frame_m, Math.abs(lift - previousLift));
        previousLift = lift;
        result.maximum_root_correction_m = Math.max(result.maximum_root_correction_m, rootBefore.distanceTo(rig.root.position));
        rig.feet.forEach((f, i) => {
          const a = f.upper.getWorldPosition(new THREE.Vector3()), b = f.lower.getWorldPosition(new THREE.Vector3()), c = f.foot.getWorldPosition(new THREE.Vector3());
          result.maximum_bone_length_error_m = Math.max(result.maximum_bone_length_error_m, Math.abs(a.distanceTo(b) - lengths[i][0]), Math.abs(b.distanceTo(c) - lengths[i][1]));
        });
      }
    }
    for (const k of Object.keys(result)) if (typeof result[k] === 'number') result[k] = round(result[k]);
    assert(result.minimum_after_m >= -0.0005, `${kind} ${scenario.name} still penetrates ${result.minimum_after_m}m`);
    assert(result.maximum_root_correction_m < 1e-8, 'Ground correction moved authoritative actor root');
    assert(result.maximum_bone_length_error_m < 1e-5, 'Ground correction stretched a bone');
    results.push(result);
  }
  const idle = loadRig(kind);
  transition(idle, 'idle'); idle.mixer.update(0); idle.root.updateMatrixWorld(true);
  const original = idle.feet.flatMap(f => [f.upper, f.lower, f.foot].map(b => b.quaternion.clone()));
  // A raised surface must not permanently change constant idle tracks.
  groundFootContacts(idle.feet, () => .025, 0);
  for (let repeat = 0; repeat < 120; repeat++) {
    restoreFootContacts(idle.feet); idle.mixer.update(0); idle.root.updateMatrixWorld(true);
    idle.feet.flatMap(f => [f.upper, f.lower, f.foot]).forEach((bone, i) => assert(bone.quaternion.toArray().every((v, j) => Math.abs(v - original[i].toArray()[j]) < 1e-7), 'IK survived a repeated constant track: ' + bone.name + ' ' + JSON.stringify([bone.quaternion.toArray(), original[i].toArray()])));
    groundFootContacts(idle.feet, () => repeat % 2 ? 0 : .025, 0);
  }
  report.models[kind] = { constant_track_restore_passed: true, sole_samples: loadRig(kind).feet.map(f => ({ bone: f.foot.name, vertices: f.indices.length })), cases: results };
  console.log(kind, JSON.stringify({ min_before: Math.min(...results.map(r => r.minimum_before_m)), min_after: Math.min(...results.map(r => r.minimum_after_m)), max_lift: Math.max(...results.map(r => r.maximum_ankle_lift_m)), max_frame_change: Math.max(...results.map(r => r.maximum_correction_change_per_frame_m)) }));
}
fs.writeFileSync(path.join(OUT, 'transition-validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log('PASS: 768 sampled-phase/ground/fps cases + 240 constant-track resets; root and bone lengths unchanged.');
