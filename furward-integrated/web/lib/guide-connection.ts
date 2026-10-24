import * as THREE from 'three';

export type GuideConnection = {
  rope: THREE.Group;
  handAnchor: THREE.Object3D;
  dogAnchor: THREE.Object3D;
  /** Applied after the animation mixer: one hand holds the lead, the other swings. */
  poseHand: () => void;
  update: () => void;
};

/** A bone-attached chest harness and a continuous lead from the user's palm. */
export function createGuideConnection(human: THREE.Object3D, dog: THREE.Object3D): GuideConnection {
  const shoulder = human.getObjectByName('human_upperarm_L');
  const elbow = human.getObjectByName('human_forearm_L');
  const hand = human.getObjectByName('human_hand_L');
  const body = dog.getObjectByName('dog_body');
  if (!shoulder || !elbow || !hand || !body) throw new Error('伙伴动画缺少牵引连接骨骼，请重试。');

  const rope = new THREE.Group();
  rope.name = 'Guide_lead';
  const webbing = new THREE.MeshStandardMaterial({ color: '#e5a42d', roughness: 0.82 });
  const cord = new THREE.MeshStandardMaterial({ color: '#544026', roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: '#292e27', roughness: 0.85 });
  const metal = new THREE.MeshStandardMaterial({ color: '#c6c8c3', metalness: 0.7, roughness: 0.35 });
  const harness = new THREE.Group();
  harness.name = 'Guide_chest_harness';
  body.add(harness);

  for (const z of [-0.15, -0.025]) {
    const points = Array.from({ length: 33 }, (_, i) => {
      const a = i / 32 * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * 0.245, Math.sin(a) * 0.145, z);
    });
    const strap = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, true), 48, 0.018, 6, true), dark);
    strap.castShadow = true;
    harness.add(strap);
  }
  const backStrap = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.025, 0.175), webbing);
  backStrap.position.set(0, 0.148, -0.0875);
  backStrap.castShadow = true;
  harness.add(backStrap);
  const buckle = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.009, 6, 18), metal);
  buckle.position.set(0, 0.17, -0.10);
  harness.add(buckle);

  const dogAnchor = new THREE.Object3D();
  dogAnchor.name = 'Guide_harness_anchor';
  dogAnchor.position.set(0, 0.19, -0.10);
  body.add(dogAnchor);
  const handAnchor = new THREE.Object3D();
  handAnchor.name = 'Guide_palm_anchor';
  handAnchor.position.set(0, -0.04, 0.015);
  hand.add(handAnchor);
  const grip = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 18), dark);
  grip.rotation.y = Math.PI / 2;
  handAnchor.add(grip);

  // Fixed geometry and reused matrices avoid rebuilding a tube at every frame.
  const count = 24;
  const segments = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 7), cord, count);
  segments.name = 'Guide_lead_segments';
  segments.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  segments.frustumCulled = false;
  segments.castShadow = true;
  rope.add(segments);
  const from = new THREE.Vector3(), to = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const direction = new THREE.Vector3(), midpoint = new THREE.Vector3(), scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), rotation = new THREE.Quaternion(), matrix = new THREE.Matrix4();
  const shoulderPose = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.42);
  const elbowPose = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.70);
  const handPose = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.12);
  const poseHand = () => {
    shoulder.quaternion.copy(shoulderPose);
    elbow.quaternion.copy(elbowPose);
    hand.quaternion.copy(handPose);
  };
  const update = () => {
    human.updateMatrixWorld(true);
    dog.updateMatrixWorld(true);
    handAnchor.getWorldPosition(from);
    dogAnchor.getWorldPosition(to);
    // A shallow droop reads as a flexible lead without reaching the pavement.
    const sag = Math.min(0.10, from.distanceTo(to) * 0.055);
    const sample = (t: number, target: THREE.Vector3) => {
      target.lerpVectors(from, to, t);
      target.y -= Math.sin(Math.PI * t) * sag;
    };
    for (let i = 0; i < count; i++) {
      sample(i / count, a);
      sample((i + 1) / count, b);
      direction.subVectors(b, a);
      const length = direction.length();
      midpoint.copy(a).add(b).multiplyScalar(0.5);
      rotation.setFromUnitVectors(up, direction.normalize());
      scale.set(0.022, length + 0.002, 0.022);
      matrix.compose(midpoint, rotation, scale);
      segments.setMatrixAt(i, matrix);
    }
    segments.instanceMatrix.needsUpdate = true;
  };
  poseHand();
  update();
  return { rope, handAnchor, dogAnchor, poseHand, update };
}
