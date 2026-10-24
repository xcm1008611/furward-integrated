#!/usr/bin/env node
/** Real exported skins + production guide connection, with no browser or asset writes.
 * Run with Node 24: node scripts/guide-connection-validate.mjs
 * Measures both lead ends, continuity, ground clearance and unchanged actor roots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from '../web/node_modules/three/build/three.module.js';
import { createGuideConnection } from '../web/lib/guide-connection.ts';
import { collectFootContacts, groundFootContacts, restoreFootContacts } from '../web/lib/foot-contact.ts';
import { GUIDE_FOLLOW_DISTANCE_M, pointAtDistance, angleDifference } from '../web/lib/demo-types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'web/public/city/animated');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'rig-manifest.json')));
const world = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/route.json')));
const speed = world.route.speed_mps;

function loadRig(kind) {
  const raw = fs.readFileSync(path.join(ASSETS, kind + '.glb'));
  const jsonLength = raw.readUInt32LE(12);
  const g = JSON.parse(raw.toString('utf8', 20, 20 + jsonLength));
  const bin = raw.subarray(28 + jsonLength);
  const accessor = index => {
    const a = g.accessors[index], view = g.bufferViews[a.bufferView];
    const C = { 5126: Float32Array, 5123: Uint16Array, 5121: Uint8Array, 5125: Uint32Array }[a.componentType];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    assert(!view.byteStride, 'Extend fixture reader before accepting strided assets');
    const start = (view.byteOffset || 0) + (a.byteOffset || 0);
    return { array: new C(Uint8Array.from(bin.subarray(start, start + a.count * size * C.BYTES_PER_ELEMENT)).buffer), size };
  };
  const jointIds = new Set(g.skins.flatMap(s => s.joints));
  const nodes = g.nodes.map((n, i) => {
    let object;
    if (n.mesh !== undefined) {
      const primitive = g.meshes[n.mesh].primitives[0], geometry = new THREE.BufferGeometry();
      for (const [attribute, name] of [['POSITION', 'position'], ['JOINTS_0', 'skinIndex'], ['WEIGHTS_0', 'skinWeight']]) {
        const a = accessor(primitive.attributes[attribute]);
        geometry.setAttribute(name, new THREE.BufferAttribute(a.array, a.size));
      }
      object = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    } else object = jointIds.has(i) ? new THREE.Bone() : new THREE.Group();
    object.name = n.name;
    if (n.translation) object.position.fromArray(n.translation);
    if (n.rotation) object.quaternion.fromArray(n.rotation);
    if (n.scale) object.scale.fromArray(n.scale);
    return object;
  });
  g.nodes.forEach((n, i) => n.children?.forEach(child => nodes[i].add(nodes[child])));
  const root = new THREE.Group();
  g.scenes[g.scene || 0].nodes.forEach(i => root.add(nodes[i]));
  root.updateMatrixWorld(true);
  g.nodes.forEach((n, i) => {
    if (n.skin === undefined) return;
    const skin = g.skins[n.skin], inverse = accessor(skin.inverseBindMatrices).array;
    nodes[i].bind(new THREE.Skeleton(skin.joints.map(j => nodes[j]), skin.joints.map((_, j) => new THREE.Matrix4().fromArray(inverse, j * 16))), nodes[i].matrixWorld);
  });
  const mixer = new THREE.AnimationMixer(root), actions = {};
  for (const animation of g.animations) {
    const tracks = animation.channels.map(channel => {
      const sampler = animation.samplers[channel.sampler];
      assert.equal(sampler.interpolation, 'LINEAR');
      const field = { rotation: 'quaternion', translation: 'position', scale: 'scale' }[channel.target.path];
      const Track = channel.target.path === 'rotation' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
      return new Track(nodes[channel.target.node].name + '.' + field, accessor(sampler.input).array, accessor(sampler.output).array);
    });
    const action = mixer.clipAction(new THREE.AnimationClip(animation.name, -1, tracks));
    if (animation.name === 'stop') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
    actions[animation.name] = action;
  }
  return { kind, root, mixer, actions, feet: collectFootContacts(root), mesh: nodes.find(n => n instanceof THREE.SkinnedMesh), current: '' };
}

const human = loadRig('human'), dog = loadRig('dog');
const guide = createGuideConnection(human.root, dog.root);
const scene = new THREE.Scene();
scene.add(human.root, dog.root, guide.rope);
assert.equal(guide.handAnchor.parent.name, 'human_hand_L');
assert.equal(guide.dogAnchor.parent.name, 'dog_body');
const arm = ['human_upperarm_L', 'human_forearm_L', 'human_hand_L'].map(name => human.root.getObjectByName(name));
const heldRotations = arm.map(bone => bone.quaternion.clone());
const rightArm = ['human_upperarm_R', 'human_forearm_R', 'human_hand_R'].map(name => human.root.getObjectByName(name));
const segments = guide.rope.getObjectByName('Guide_lead_segments');
assert(segments instanceof THREE.InstancedMesh && segments.count > 1);
const report = {
  frames: 0, clip_and_transition_cases: 0, route_cases: [],
  maximum_root_change_m: 0, maximum_hand_pose_change_rad: 0,
  maximum_endpoint_error_m: 0, maximum_segment_join_error_m: 0,
  minimum_lead_height_above_floor_m: Infinity, minimum_anchor_distance_m: Infinity,
  maximum_anchor_distance_m: 0, maximum_grip_to_hand_mesh_m: 0,
};
const matrix = new THREE.Matrix4(), first = new THREE.Vector3(), last = new THREE.Vector3();
const palm = new THREE.Vector3(), harness = new THREE.Vector3(), vertex = new THREE.Vector3();
const handJoint = human.mesh.skeleton.bones.findIndex(b => b.name === 'human_hand_L');
const skinIndex = human.mesh.geometry.getAttribute('skinIndex'), skinWeight = human.mesh.geometry.getAttribute('skinWeight');
const handVertices = Array.from({ length: skinIndex.count }, (_, i) => i).filter(i => {
  let weight = 0;
  for (let j = 0; j < 4; j++) if (skinIndex.getComponent(i, j) === handJoint) weight += skinWeight.getComponent(i, j);
  return weight > .75;
});
assert(handVertices.length > 20, 'Grip check requires actual hand geometry');

function play(actor, clip, phase = 0) {
  const action = actor.actions[clip];
  action.reset().setEffectiveWeight(1).setEffectiveTimeScale(clip === 'walk' ? speed / manifest.models[actor.kind].nominal_walk_speed_mps : 1).play();
  action.time = phase * action.getClip().duration;
  if (actor.current && actor.current !== clip) actor.actions[actor.current].crossFadeTo(action, .22, false);
  actor.current = clip;
}

function frame(dt, floor = 0) {
  const rootStates = [human, dog].map(actor => ({ p: actor.root.position.clone(), q: actor.root.quaternion.clone() }));
  for (const actor of [human, dog]) {
    restoreFootContacts(actor.feet);
    actor.mixer.update(dt);
    if (actor === human) {
      const rightBefore = rightArm.map(b => b.quaternion.clone());
      guide.poseHand();
      rightArm.forEach((b, i) => assert(b.quaternion.toArray().every((v, j) => v === rightBefore[i].toArray()[j]), 'Holding the lead changed the free arm'));
    }
    actor.root.updateMatrixWorld(true);
    groundFootContacts(actor.feet, () => floor, floor);
  }
  guide.update();
  guide.rope.updateMatrixWorld(true);
  [human, dog].forEach((actor, i) => {
    report.maximum_root_change_m = Math.max(report.maximum_root_change_m, actor.root.position.distanceTo(rootStates[i].p));
    assert(actor.root.quaternion.angleTo(rootStates[i].q) < 1e-7, 'Lead changed route yaw');
  });
  arm.forEach((bone, i) => { report.maximum_hand_pose_change_rad = Math.max(report.maximum_hand_pose_change_rad, bone.quaternion.angleTo(heldRotations[i])); });
  guide.handAnchor.getWorldPosition(palm); guide.dogAnchor.getWorldPosition(harness);
  const distance = palm.distanceTo(harness);
  report.minimum_anchor_distance_m = Math.min(report.minimum_anchor_distance_m, distance);
  report.maximum_anchor_distance_m = Math.max(report.maximum_anchor_distance_m, distance);
  let previous = null;
  for (let i = 0; i < segments.count; i++) {
    segments.getMatrixAt(i, matrix); matrix.premultiply(segments.matrixWorld);
    assert(matrix.elements.every(Number.isFinite), 'Lead contains a non-finite segment');
    first.set(0, -.5, 0).applyMatrix4(matrix); last.set(0, .5, 0).applyMatrix4(matrix);
    if (i === 0) report.maximum_endpoint_error_m = Math.max(report.maximum_endpoint_error_m, first.distanceTo(palm));
    if (i === segments.count - 1) report.maximum_endpoint_error_m = Math.max(report.maximum_endpoint_error_m, last.distanceTo(harness));
    if (previous) report.maximum_segment_join_error_m = Math.max(report.maximum_segment_join_error_m, first.distanceTo(previous));
    previous = last.clone();
    // Exact mesh vertices, including lead radius and the small segment overlap.
    const position = segments.geometry.getAttribute('position');
    for (let j = 0; j < position.count; j++) {
      vertex.fromBufferAttribute(position, j).applyMatrix4(matrix);
      report.minimum_lead_height_above_floor_m = Math.min(report.minimum_lead_height_above_floor_m, vertex.y - floor);
    }
  }
  if (report.frames % 30 === 0) {
    let nearest = Infinity;
    for (const i of handVertices) {
      human.mesh.getVertexPosition(i, vertex); vertex.applyMatrix4(human.mesh.matrixWorld);
      nearest = Math.min(nearest, vertex.distanceTo(palm));
    }
    report.maximum_grip_to_hand_mesh_m = Math.max(report.maximum_grip_to_hand_mesh_m, nearest);
  }
  report.frames++;
}

// Repeated pose calls cannot accumulate rotations, including constant animation tracks.
for (let i = 0; i < 240; i++) guide.poseHand();
arm.forEach((bone, i) => assert(bone.quaternion.angleTo(heldRotations[i]) < 1e-7));
const transitions = [['idle', 'walk'], ['walk', 'stop'], ['stop', 'walk'], ['walk', 'turn_left'], ['walk', 'turn_right'], ['turn_left', 'idle']];
for (const [from, to] of transitions) for (let phase = 0; phase < 16; phase++) {
  for (const actor of [human, dog]) {
    actor.mixer.stopAllAction(); actor.current = '';
    actor.root.position.set(20, .028, actor === human ? -GUIDE_FOLLOW_DISTANCE_M : 0);
    actor.root.rotation.set(0, 0, 0); play(actor, from, phase / 16); actor.mixer.update(0); play(actor, to);
  }
  for (let i = 0; i < 48; i++) frame(1 / 60, .025);
  report.clip_and_transition_cases++;
}

const original = world.route.points;
const a = original[0], b = original[1];
const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
const detour = [a, ...Array.from({ length: 25 }, (_, i) => {
  const along = 32 + i / 24 * 12, side = 2.4 * Math.sin(Math.PI * i / 24) ** 2;
  return { x: a.x + dx / length * along - dz / length * side, y: a.y, z: a.z + dz / length * along + dx / length * side };
}), ...original.slice(1)];
for (const [name, points] of [['original_route', original], ['sinusoidal_2_4m_detour', detour]]) {
  const total = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y, p.z - points[i].z), 0);
  for (const actor of [human, dog]) { actor.mixer.stopAllAction(); actor.current = ''; play(actor, 'walk'); }
  const frames = Math.ceil(total / speed * 60);
  for (let i = 0; i <= frames; i++) {
    const distance = Math.min(total, i / 60 * speed);
    for (const actor of [human, dog]) {
      const target = pointAtDistance(points, distance - (actor === human ? GUIDE_FOLLOW_DISTANCE_M : 0), true);
      actor.root.position.set(target.point.x, target.point.y + .003, target.point.z);
      if (i === 0) actor.root.rotation.y = target.heading;
      else actor.root.rotation.y += angleDifference(target.heading, actor.root.rotation.y) * 8 / 60;
    }
    frame(1 / 60, .025);
  }
  report.route_cases.push({ name, metres: total, frames: frames + 1 });
}
assert(report.maximum_root_change_m < 1e-9, 'Lead moved an authoritative route root');
assert(report.maximum_hand_pose_change_rad < 1e-7, 'Grip pose accumulates or loses priority');
assert(report.maximum_endpoint_error_m < .002, 'A lead endpoint detached from its bone anchor');
assert(report.maximum_segment_join_error_m < .003, 'Lead segments became discontinuous');
assert(report.minimum_lead_height_above_floor_m > .5, 'Lead droops into the pavement');
assert(report.minimum_anchor_distance_m > .6 && report.maximum_anchor_distance_m < 3, 'Lead length is outside the 2.2m-follow formation envelope');
assert(report.maximum_grip_to_hand_mesh_m < .06, 'Lead anchor is visibly away from the real skinned palm');
console.log(JSON.stringify(report, null, 2));
console.log('PASS: actual human/dog GLBs; held hand, bone-attached endpoints, continuous lead, root preservation and route/corner clearance.');
console.log('Scope: horizontal ground clearance and route formation; does not establish arbitrary-object rope collision or finger articulation.');
