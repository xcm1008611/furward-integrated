"""Build an editable Blender review scene from the delivered character GLBs.

Run from the project root:
  blender --background --python-exit-code 1 --python scripts/build-blender-review.py

This scene checks a straight 2.4 m walk. Web runtime terrain/crossfade IK remains
in CityScene.tsx and is verified by rig-transition-validate.mjs.
"""
import hashlib
import json
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "source-assets/characters"
PREVIEWS = ROOT / "docs/screenshots"
FPS = 60
SPEED = 1.2
END = 121


def aim(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat("-Z", "Y").to_euler()


def import_actor(kind, start_y, manifest):
    path = ROOT / f"web/public/city/animated/{kind}.glb"
    old_objects = set(bpy.data.objects)
    old_actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(path), disable_bone_shape=True, import_pack_images=True)
    objects = set(bpy.data.objects) - old_objects
    armature = next(obj for obj in objects if obj.type == "ARMATURE")
    meshes = [obj for obj in objects if obj.type == "MESH"]
    actions = {}
    for action in set(bpy.data.actions) - old_actions:
        short = action.name.split(".")[0]
        actions[short] = action
        action.name = f"{kind}_{short}"
        action.use_fake_user = True
    assert set(actions) == {"idle", "walk", "turn_left", "turn_right", "stop"}
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    armature.animation_data.action = None
    walk = actions["walk"]
    track = armature.animation_data.nla_tracks.new()
    track.name = "REVIEW — 1.2 m/s walk (mute to edit other clips)"
    strip = track.strips.new(f"{kind}_review_walk", 1, walk)
    strip.action_slot = walk.slots[0]
    strip.scale = manifest["nominal_walk_speed_mps"] / SPEED
    strip.repeat = (END - 1) / (walk.frame_range[1] * strip.scale)
    strip.extrapolation = "NOTHING"
    strip.blend_type = "REPLACE"
    parent = bpy.data.objects.new(f"{kind}_route_translation", None)
    bpy.context.scene.collection.objects.link(parent)
    armature.parent = parent
    # glTF +Z forward becomes Blender -Y; this parent supplies route movement.
    parent.location = (0, start_y, 0.003)
    parent.keyframe_insert(data_path="location", frame=1)
    parent.location.y = start_y - SPEED * (END - 1) / FPS
    parent.keyframe_insert(data_path="location", frame=END)
    for layer in parent.animation_data.action.layers:
        for action_strip in layer.strips:
            for bag in action_strip.channelbags:
                for curve in bag.fcurves:
                    for key in curve.keyframe_points:
                        key.interpolation = "LINEAR"
    route_action = parent.animation_data.action
    route_action.use_fake_user = True
    route_track = parent.animation_data.nla_tracks.new()
    route_track.name = "REVIEW — route translation (mute for in-place)"
    route_strip = route_track.strips.new(f"{kind}_review_translation", 1, route_action)
    route_strip.action_slot = route_action.slots[0]
    parent.animation_data.action = None
    parent.location = (0, start_y, 0.003)
    parent["route_speed_mps"] = SPEED
    parent["review_distance_m"] = 2.4
    parent["runtime_note"] = "Web route and per-foot terrain IK live in CityScene.tsx; this is a straight walk review."
    return {"armature": armature, "meshes": meshes, "parent": parent,
            "actions": actions, "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.unit_settings.system = "METRIC"
    scene.frame_start, scene.frame_end = 1, END
    manifest = json.loads((ROOT / "web/public/city/animated/rig-manifest.json").read_text())["models"]
    actors = {kind: import_actor(kind, y, manifest[kind]) for kind, y in [("human", 2.2), ("dog", 0.0)]}
    metrics = {}
    for kind, actor in actors.items():
        minima, starts, ends = [], [], []
        for frame in range(1, END + 1):
            scene.frame_set(frame)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            points = []
            for mesh in actor["meshes"]:
                evaluated = mesh.evaluated_get(depsgraph)
                data = evaluated.to_mesh()
                points.extend(evaluated.matrix_world @ vertex.co for vertex in data.vertices)
                evaluated.to_mesh_clear()
            minima.append(min(point.z for point in points))
            if frame == 1:
                starts = [tuple(point) for point in points]
            if frame == END:
                ends = [tuple(point) for point in points]
        scene.frame_set(1)
        start_position = actor["parent"].location.copy()
        scene.frame_set(END)
        distance = (actor["parent"].location - start_position).length
        assert abs(distance - 2.4) < 1e-5, (kind, distance)
        assert min(minima) > -0.004, (kind, min(minima))
        assert starts != ends
        metrics[kind] = {"bones": len(actor["armature"].data.bones),
                         "actions": sorted(actor["actions"]), "source_sha256": actor["source_sha256"],
                         "travel_distance_m": distance, "minimum_world_foot_height_m": min(minima),
                         "frames_sampled": END}
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
    floor = bpy.context.object
    floor.name = "Review floor (not part of delivered character geometry)"
    material = bpy.data.materials.new("Review warm grey")
    material.diffuse_color = (0.32, 0.35, 0.33, 1)
    floor.data.materials.append(material)
    world = bpy.data.worlds.new("Review studio world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.32, 0.36, 0.42, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    scene.world = world
    for location, energy, size in [((3, 0, 6), 1600, 5), ((-4, -3, 4), 1000, 4)]:
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.data.energy, light.data.shape, light.data.size = energy, "DISK", size
        aim(light, (0, -0.1, 0.7))
    bpy.ops.object.camera_add(location=(6, 4, 3.3))
    camera = bpy.context.object
    aim(camera, (0, -0.1, 0.85))
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 6.5
    scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 1200, 850
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.frame_set(1)
    bpy.ops.file.pack_all()
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
                area.spaces.active.shading.type = "MATERIAL"
    path = OUTPUT / "Furward_Characters_Animated.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(path))
    for frame in [1, 61, END]:
        scene.frame_set(frame)
        scene.render.filepath = str(PREVIEWS / f"blender-walk-{frame:03}.png")
        bpy.ops.render.render(write_still=True)
    report = {"blender_version": bpy.app.version_string, "fps": FPS, "speed_mps": SPEED,
              "duration_seconds": (END - 1) / FPS, "actors": metrics,
              "scope": "Editable GLB imports; preserved clips/materials/textures; straight walk. Runtime terrain and transition IK are verified separately."}
    (OUTPUT / "blender-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    print("FURWARD_BLENDER_REVIEW", json.dumps(report))


if __name__ == "__main__":
    main()
