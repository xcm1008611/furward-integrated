"""Build one metre-based route contract from the delivered city and 2D map.

No GIS approximation: undo the exact rotation used by export_demo_city.py.
Run from any directory with Python's standard library.
"""
import json
import math
import struct
from itertools import product
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def detour_blockers():
    """Project the delivered collision bodies onto XZ, conservatively at all heights."""
    manifest = json.loads((ROOT / 'source-assets/city/assets/collision_manifest.json').read_text())

    def hull(points):
        points = sorted(set(points))
        def cross(a, b, c):
            return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        def half(sequence):
            result = []
            for p in sequence:
                while len(result) >= 2 and cross(result[-2], result[-1], p) <= 0:
                    result.pop()
                result.append(p)
            return result
        return half(points)[:-1] + half(reversed(points))[:-1]

    result = []
    for collider in manifest['colliders']:
        if collider['shape'] == 'trimesh':
            continue
        if collider['shape'] == 'cuboid':
            local = product(*[(-v, v) for v in collider['halfExtents']])
        elif collider['shape'] == 'convexHull':
            vertices = collider['vertices']
            local = [vertices[i:i + 3] for i in range(0, len(vertices), 3)]
        else:
            raise ValueError('Unknown collision shape; detour clearance cannot be verified')
        qx, qy, qz, qw = collider['rotation_xyzw']
        px, _, pz = collider['position']
        points = []
        for x, y, z in local:
            # Quaternion rotation q * v * q^-1 for the source's unit quaternion.
            tx, ty, tz = 2 * (qy*z - qz*y), 2 * (qz*x - qx*z), 2 * (qx*y - qy*x)
            points.append((x + qw*tx + qy*tz - qz*ty + px,
                           z + qw*tz + qx*ty - qy*tx + pz))
        polygon = hull(points)
        if len(polygon) < 3:
            raise ValueError('Degenerate obstacle footprint')
        result.append(polygon)
    return result


def positions(data, gltf, binary_start, mesh):
    for primitive in mesh['primitives']:
        accessor = gltf['accessors'][primitive['attributes']['POSITION']]
        assert accessor['componentType'] == 5126 and accessor['type'] == 'VEC3'
        view = gltf['bufferViews'][accessor['bufferView']]
        start = binary_start + view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        stride = view.get('byteStride', 12)
        for i in range(accessor['count']):
            yield struct.unpack_from('<fff', data, start + i * stride)


def main():
    raw = (ROOT / 'source-assets/city/assets/city_visual_v08.glb').read_bytes()
    length = struct.unpack_from('<I', raw, 12)[0]
    gltf = json.loads(raw[20:20 + length])
    theta = math.radians(-52)
    c, s = math.cos(theta), math.sin(theta)
    ground = []
    for node in gltf['nodes']:
        if node.get('name') in {'City_Base', 'Ground_Extension_Seamless'}:
            assert not any(key in node for key in ('matrix', 'translation', 'rotation', 'scale'))
            ground.extend(positions(raw, gltf, 28 + length, gltf['meshes'][node['mesh']]))
    planar = [(c * x - s * z, -s * x - c * z) for x, _, z in ground]
    origin = [min(p[i] for p in planar) for i in (0, 1)]
    city = json.loads((ROOT / 'robot/backend/data/demo_city.json').read_text())
    legacy = json.loads((ROOT / 'robot/backend/data/demo_routes/city_demo.json').read_text())
    points = []
    for a, b in city['route']:
        u, v = a + origin[0], b + origin[1]
        points.append({'x': round(c * u - s * v, 7), 'y': 0.025, 'z': round(-s * u - c * v, 7)})
    # Verify the inverse against the actual five rung centres of the delivered GLB.
    route_node = next(node for node in gltf['nodes'] if node.get('name') == 'Route_Pedestrian_Verge')
    route_vertices = list(positions(raw, gltf, 28 + length, gltf['meshes'][route_node['mesh']]))
    nearest = [min((j for j in range(len(route_vertices)) if j != i),
                   key=lambda j: math.dist(vertex, route_vertices[j]))
               for i, vertex in enumerate(route_vertices)]
    rungs = [(i, j) for i, j in enumerate(nearest) if i < j and nearest[j] == i]
    centres = [tuple((route_vertices[i][k] + route_vertices[j][k]) / 2 for k in (0, 2)) for i, j in rungs]
    assert len(centres) == len(points) == 5
    errors = [min(math.hypot(p['x'] - x, p['z'] - z) for x, z in centres) for p in points]
    assert max(errors) < 0.08, f'Route does not match original GLB: {errors}'
    steps, cumulative = [], 0.0
    for i, (a, b) in enumerate(zip(points, points[1:])):
        distance = round(math.hypot(b['x'] - a['x'], b['z'] - a['z']), 6)
        steps.append({**{k: legacy['steps'][i][k] for k in ('index', 'instruction', 'action')},
                      'start_m': round(cumulative, 6), 'end_m': round(cumulative + distance, 6),
                      'distance_m': distance})
        cumulative += distance
    assert abs(cumulative - legacy['distance_m']) < 0.01
    world = {
        'version': 1, 'coordinate_system': 'Y-up metres',
        'route': {'route_id': 'demo-city', 'points': points, 'steps': steps,
                  'total_distance_m': round(cumulative, 6), 'speed_mps': 1.2,
                  'start_name': city['start_name'], 'destination_name': city['destination_name'],
                  'obstacle_distance_m': 32},
        'assets': {'city': '/city/city_visual_v08.glb', 'periphery': '/city/city_periphery_v10.glb',
                   'human': '/city/animated/human.glb', 'dog': '/city/animated/dog.glb'},
        'transform': {'planar': ['x', '-z'], 'clockwise_degrees': -52,
                      'rotated_origin': origin, 'description': 'local2d = R(-52) * (world.x, -world.z) - rotated_origin'},
        'map': city,
        'detour_blockers': detour_blockers(),
        'validation': {'max_rung_error_m': max(errors), 'rung_count': len(centres)},
    }
    dest = ROOT / 'shared/route.json'
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(world, ensure_ascii=False, indent=2) + '\n')
    print(f'Exported {len(points)} points, {cumulative:.1f} m to {dest}')


if __name__ == '__main__':
    main()
