/** Asset wiring only. No gameplay loop, character controller or animation. */
export async function loadCityBundle({ loader, scene, baseUrl, characters = 'placed' }) {
  if (!['placed', 'individual', 'none'].includes(characters)) throw new Error('Invalid characters option');
  const base = new URL(baseUrl, globalThis.location?.href ?? 'http://localhost/');
  const url = p => new URL(p, base).href;
  const response = await fetch(url('scene_manifest.json'));
  if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
  const manifest = await response.json();
  const [core, periphery] = await Promise.all([
    loader.loadAsync(url(manifest.files.core)), loader.loadAsync(url(manifest.files.periphery))
  ]);
  scene.add(core.scene, periphery.scene);
  const roots = {};
  if (characters === 'placed') {
    const placed = await loader.loadAsync(url(manifest.files.characters_placed));
    scene.add(placed.scene);
    for (const [name, spawn] of Object.entries(manifest.spawn)) roots[name] = placed.scene.getObjectByName(spawn.root);
  } else if (characters === 'individual') {
    for (const [name, asset] of [['BlindPerson', manifest.files.human], ['RobotDog', manifest.files.dog]]) {
      const gltf = await loader.loadAsync(url(asset));
      const spawn = manifest.spawn[name];
      const root = gltf.scene.getObjectByName(spawn.root);
      if (!root) throw new Error(`Missing root: ${spawn.root}`);
      root.position.fromArray(spawn.position_gltf);
      root.rotation.set(0, spawn.yaw_gltf_rad, 0);
      scene.add(gltf.scene); roots[name] = root;
    }
  }
  return { core: core.scene, periphery: periphery.scene, roots, manifest };
}

/** Call after RAPIER.init(). Collision scene is intentionally never added to the visible scene. */
export async function loadStaticCityCollision({ THREE, RAPIER, world, loader, baseUrl }) {
  const base = new URL(baseUrl, globalThis.location?.href ?? 'http://localhost/');
  const response = await fetch(new URL('assets/collision_manifest.json', base));
  if (!response.ok) throw new Error(`collision manifest HTTP ${response.status}`);
  const manifest = await response.json();
  const gltf = await loader.loadAsync(new URL('assets/city_collision_v09.glb', base).href);
  gltf.scene.updateMatrixWorld(true);
  const bodies = [], colliders = [];
  try {
    for (const entry of manifest.colliders) {
      let shape, body;
      if (entry.shape === 'trimesh') {
        const node = gltf.scene.getObjectByName(entry.name);
        if (!node?.isMesh) throw new Error(`Missing ground mesh ${entry.name}`);
        const attr = node.geometry.getAttribute('position');
        const vertices = new Float32Array(attr.count * 3), v = new THREE.Vector3();
        for (let i = 0; i < attr.count; i++) {
          v.fromBufferAttribute(attr, i).applyMatrix4(node.matrixWorld); v.toArray(vertices, i * 3);
        }
        const index = node.geometry.index;
        const indices = index ? Uint32Array.from(index.array) : Uint32Array.from({ length: attr.count }, (_, i) => i);
        shape = RAPIER.ColliderDesc.trimesh(vertices, indices);
        // Ground vertices already world-transformed: no second position/rotation application.
        body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      } else {
        if (entry.shape === 'cuboid') shape = RAPIER.ColliderDesc.cuboid(...entry.halfExtents);
        else if (entry.shape === 'convexHull') shape = RAPIER.ColliderDesc.convexHull(Float32Array.from(entry.vertices.flat()));
        else throw new Error(`Unsupported shape ${entry.shape}`);
        if (!shape) throw new Error(`Degenerate hull ${entry.name}`);
        const [x, y, z] = entry.position, [qx, qy, qz, qw] = entry.rotation_xyzw;
        body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation({ x: qx, y: qy, z: qz, w: qw }));
      }
      bodies.push(body);
      shape.setFriction(entry.friction ?? 0.7).setRestitution(entry.restitution ?? 0);
      colliders.push(world.createCollider(shape, body));
    }
  } catch (error) {
    for (const body of bodies) world.removeRigidBody(body);
    throw error;
  }
  return { bodies, colliders, count: colliders.length };
}
