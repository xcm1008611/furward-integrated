import * as THREE from 'three';

/** A small post-animation constraint for the two supplied, uniformly scaled rigs.
 * Measure actual skinned sole vertices, then bend the existing hip/knee chain to
 * lift a penetrating foot. It never translates the actor or stretches a bone.
 */
export type GroundHeight = (x: number, z: number, fallback: number) => number;
export type FootContact = {
  mesh: THREE.SkinnedMesh;
  foot: THREE.Bone;
  lower: THREE.Bone;
  upper: THREE.Bone;
  indices: number[];
  animationRotations?: THREE.Quaternion[];
};

const CLEARANCE = 0.001;

export function collectFootContacts(root: THREE.Object3D): FootContact[] {
  const feet: FootContact[] = [];
  root.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    const position = object.geometry.getAttribute('position');
    const joints = object.geometry.getAttribute('skinIndex');
    const weights = object.geometry.getAttribute('skinWeight');
    if (!position || !joints || !weights) return;
    object.skeleton.bones.forEach((foot, boneIndex) => {
      if (!foot.name.includes('_foot_')) return;
      const lower = foot.parent, upper = lower?.parent;
      if (!(lower instanceof THREE.Bone) || !(upper instanceof THREE.Bone)) return;
      const candidates: number[] = [];
      let soleY = Infinity;
      for (let i = 0; i < position.count; i++) {
        for (let slot = 0; slot < 4; slot++) {
          if (joints.getComponent(i, slot) === boneIndex && weights.getComponent(i, slot) > 0.999) {
            candidates.push(i);
            soleY = Math.min(soleY, position.getY(i));
            break;
          }
        }
      }
      // Keep the original sole's corners, including the robot's slightly tilted
      // feet. UV/normal seam duplicates do not need repeated ray casts.
      const seen = new Set<string>();
      const indices = candidates.filter(i => {
        if (position.getY(i) > soleY + 0.025) return false;
        const key = [position.getX(i), position.getY(i), position.getZ(i)].map(v => v.toFixed(5)).join(',');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (indices.length) feet.push({ mesh: object, foot, lower, upper, indices });
    });
  });
  return feet;
}

/** PropertyMixer skips writing a constant track when its sampled value did not
 * change. Restore its last unmodified pose before update(), otherwise an IK
 * adjustment could survive indefinitely in idle or an exactly repeated phase.
 */
export function restoreFootContacts(feet: FootContact[]) {
  for (const contact of feet) {
    if (!contact.animationRotations) continue;
    [contact.upper, contact.lower, contact.foot].forEach((bone, i) => bone.quaternion.copy(contact.animationRotations![i]));
  }
}

function setWorldRotation(bone: THREE.Bone, worldRotation: THREE.Quaternion) {
  const parentRotation = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentRotation.invert().multiply(worldRotation));
  bone.updateMatrixWorld(true);
}

function liftFoot(contact: FootContact, lift: number) {
  const { upper, lower, foot } = contact;
  const hip = upper.getWorldPosition(new THREE.Vector3());
  const knee = lower.getWorldPosition(new THREE.Vector3());
  const ankle = foot.getWorldPosition(new THREE.Vector3());
  const footRotation = foot.getWorldQuaternion(new THREE.Quaternion());
  const target = ankle.clone().add(new THREE.Vector3(0, lift, 0));
  const upperLength = hip.distanceTo(knee), lowerLength = knee.distanceTo(ankle);
  if (Math.min(upperLength, lowerLength) < 0.0001) return;
  const direction = target.clone().sub(hip);
  const distance = THREE.MathUtils.clamp(direction.length(), 0.0001, upperLength + lowerLength - 0.000001);
  direction.normalize();
  // Preserve the current bend plane so a crossfade cannot flip a knee sideways.
  const bend = knee.clone().sub(hip);
  bend.addScaledVector(direction, -bend.dot(direction));
  if (bend.lengthSq() < 1e-10) {
    bend.set(0, 0, foot.name.startsWith('human_') ? 1 : -1);
    bend.applyQuaternion(upper.parent!.getWorldQuaternion(new THREE.Quaternion()));
    bend.addScaledVector(direction, -bend.dot(direction));
  }
  bend.normalize();
  const along = (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
  const targetKnee = hip.clone().addScaledVector(direction, along).addScaledVector(bend, height);
  const upperDelta = new THREE.Quaternion().setFromUnitVectors(knee.clone().sub(hip).normalize(), targetKnee.clone().sub(hip).normalize());
  setWorldRotation(upper, upperDelta.multiply(upper.getWorldQuaternion(new THREE.Quaternion())));
  const movedKnee = lower.getWorldPosition(new THREE.Vector3());
  const movedAnkle = foot.getWorldPosition(new THREE.Vector3());
  const lowerDelta = new THREE.Quaternion().setFromUnitVectors(movedAnkle.sub(movedKnee).normalize(), target.clone().sub(movedKnee).normalize());
  setWorldRotation(lower, lowerDelta.multiply(lower.getWorldQuaternion(new THREE.Quaternion())));
  // Keep the blended foot orientation; only the ankle position is corrected.
  setWorldRotation(foot, footRotation);
}

export function groundFootContacts(feet: FootContact[], groundHeight: GroundHeight, fallback: number): number {
  const point = new THREE.Vector3();
  let maximumLift = 0;
  for (const contact of feet) {
    contact.animationRotations ??= [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
    [contact.upper, contact.lower, contact.foot].forEach((bone, i) => contact.animationRotations![i].copy(bone.quaternion));
    let lift = 0;
    for (const index of contact.indices) {
      contact.mesh.getVertexPosition(index, point);
      point.applyMatrix4(contact.mesh.matrixWorld);
      const ground = groundHeight(point.x, point.z, fallback);
      lift = Math.max(lift, ground + CLEARANCE - point.y);
    }
    if (lift > 0.00001) {
      liftFoot(contact, lift);
      maximumLift = Math.max(maximumLift, lift);
    }
  }
  return maximumLift;
}
