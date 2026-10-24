"""把 Blender 演示城市导出成手机页用的二维地图和离线演示路线；在 backend 目录运行。

用法：
  ../.venv/bin/python scripts/export_demo_city.py \
      --glb ../../city-art-v08/city_visual_v08.glb \
      --colliders ../../city-collision-v09/collision_manifest.json
"""
import argparse
import json
import math
import struct
import sys
from pathlib import Path

import cv2
import numpy as np

BACKEND = Path(__file__).resolve().parents[1]
LAYERS = {
    'ground': ['City_Base', 'Ground_Extension_Seamless'],
    'roads': ['Road_Main_4Segments', 'Extended_Street_Network'],
    'walks': ['Continuous_Sidewalks', 'Building_Plaza_Links'],
    'lawns': ['Continuous_Lawns', 'Grouped_Lawns_Extended'],
    'route': ['Route_Pedestrian_Verge'],
}
PX_PER_M = 2
COMPONENT = {5126: 'f', 5125: 'I', 5123: 'H', 5121: 'B'}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
# 虚构城市挂在默认演示起点上，只用于离线演示，不对应真实街道
ANCHOR = (121.5901, 31.2032)
START_NAME, DEST_NAME = '西街口', '街心花园'


class Glb:
    def __init__(self, path):
        self.data = Path(path).read_bytes()
        length, _ = struct.unpack_from('<II', self.data, 12)
        self.gltf = json.loads(self.data[20:20 + length])
        self.bin = 20 + length + 8
        self.nodes = {n.get('name'): n for n in self.gltf['nodes']}

    def accessor(self, index):
        acc = self.gltf['accessors'][index]
        view = self.gltf['bufferViews'][acc['bufferView']]
        fmt, width = COMPONENT[acc['componentType']], WIDTH[acc['type']]
        dtype = np.dtype('<' + fmt)
        stride = view.get('byteStride') or dtype.itemsize * width
        start = self.bin + view.get('byteOffset', 0) + acc.get('byteOffset', 0)
        raw = np.frombuffer(self.data, np.uint8, stride * (acc['count'] - 1) + dtype.itemsize * width, start)
        rows = np.lib.stride_tricks.as_strided(raw, (acc['count'], dtype.itemsize * width), (stride, 1))
        return np.ascontiguousarray(rows).view(dtype).reshape(acc['count'], width).astype(float)

    def triangles(self, name):
        node = self.nodes[name]
        # 这些地面网格的顶点已是世界坐标，节点没有变换
        assert not any(k in node for k in ('translation', 'rotation', 'scale', 'matrix')), name
        out = []
        for prim in self.gltf['meshes'][node['mesh']]['primitives']:
            verts = self.accessor(prim['attributes']['POSITION'])
            index = self.accessor(prim['indices']).astype(int).reshape(-1, 3)
            out.append(verts[index])
        return np.concatenate(out)


def plan(points):
    # glTF Y-up：x 向东，-z 向北
    points = np.asarray(points, float)
    return np.stack([points[..., 0], -points[..., 2]], -1)


def yaw_matrix(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * z + y * w)], [2 * (x * z - y * w), 1 - 2 * (x * x + y * y)]])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--glb', required=True)
    parser.add_argument('--colliders', required=True)
    args = parser.parse_args()
    glb = Glb(args.glb)
    tris = {key: plan(np.concatenate([glb.triangles(n) for n in names])) for key, names in LAYERS.items()}

    # 城市整体斜放，转正后地图上方即为“北”
    (cx, cy), _, angle = cv2.minAreaRect(tris['ground'].reshape(-1, 2).astype(np.float32))
    theta = math.radians(angle)
    rot = np.array([[math.cos(theta), math.sin(theta)], [-math.sin(theta), math.cos(theta)]])
    center = np.array([cx, cy])
    to_local = lambda p: (np.asarray(p) - center) @ rot.T
    ground = to_local(tris['ground'].reshape(-1, 2))
    origin = ground.min(0)
    size = ground.max(0) - origin
    local = lambda p: np.round(to_local(p) - origin, 2)

    w, h = (np.ceil(size * PX_PER_M) + 4).astype(int)

    def rings(triangles):
        mask = np.zeros((h, w), np.uint8)
        for tri in local(triangles):
            pts = np.round(np.stack([tri[:, 0] * PX_PER_M + 2, (size[1] - tri[:, 1]) * PX_PER_M + 2], -1)).astype(np.int32)
            cv2.fillConvexPoly(mask, pts, 255)
        contours, _ = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        out = []
        for c in contours:
            c = cv2.approxPolyDP(c, 0.8 * PX_PER_M, True).reshape(-1, 2)
            if len(c) < 3 or cv2.contourArea(c) < 4 * PX_PER_M ** 2:
                continue
            out.append([[round((x - 2) / PX_PER_M, 1), round(size[1] - (y - 2) / PX_PER_M, 1)] for x, y in c])
        return out, mask

    city = {'name': '演示城市', 'source': 'City_Scene_v08_Art / City_Scene_v09_Collisions',
            'note': '虚构演示城市，仅用于离线演示，不对应真实街道',
            'width_m': round(float(size[0]), 1), 'height_m': round(float(size[1]), 1)}
    for key in ('ground', 'roads', 'walks', 'lawns'):
        city[key], _ = rings(tris[key])

    manifest = json.loads(Path(args.colliders).read_text(encoding='utf-8'))
    buildings, trees = [], []
    for col in manifest['colliders']:
        if col['category'] == 'Buildings' and col['shape'] == 'cuboid':
            hx, hy, hz = col['halfExtents']
            m = yaw_matrix(col['rotation_xyzw'])
            corners = [m @ np.array([sx * hx, sz * hz]) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            pts = [[col['position'][0] + c[0], col['position'][1], col['position'][2] + c[1]] for c in corners]
            buildings.append({'h': round(hy * 2, 1), 'poly': local(plan(pts)).tolist()})
        elif col['category'] == 'TreeTrunks':
            trees.append(local(plan([col['position']])[0]).round(1).tolist())
    # 先画矮楼再画高楼，高楼的阴影不被遮住
    city['buildings'] = sorted(buildings, key=lambda b: b['h'])
    city['trees'] = trees

    route = centerline(local(tris['route']))
    city['route'] = route
    city['start_name'], city['destination_name'] = START_NAME, DEST_NAME
    city['anchor'] = {'lng': ANCHOR[0], 'lat': ANCHOR[1], 'x': route[0][0], 'y': route[0][1]}
    (BACKEND / 'data' / 'demo_city.json').write_text(json.dumps(city, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    write_route(route, city['anchor'])
    print('已导出', len(buildings), '栋建筑、', len(trees), '棵树，路线', len(route) - 1, '段')


def centerline(triangles):
    # 步行路线网格是一串四边形：每个拐点有一对“横档”顶点，取其中点再按三角形连通顺序串起来
    verts, index = np.unique(np.round(triangles.reshape(-1, 2), 3), axis=0, return_inverse=True)
    index = index.reshape(-1, 3)
    dist = np.hypot(*(verts[:, None] - verts[None]).transpose(2, 0, 1)) + np.eye(len(verts)) * 1e9
    mate = dist.argmin(1)
    rungs = sorted({tuple(sorted((i, int(mate[i])))) for i in range(len(verts)) if mate[mate[i]] == i})
    rung_of = {v: r for r, pair in enumerate(rungs) for v in pair}
    links = {r: set() for r in range(len(rungs))}
    for tri in index:
        ids = {rung_of[v] for v in tri if v in rung_of}
        for a in ids:
            links[a] |= ids - {a}
    ends = [r for r, near in links.items() if len(near) == 1]
    # 从靠北（北侧道路）那一端出发
    mid = lambda r: verts[list(rungs[r])].mean(0)
    order = [max(ends, key=lambda r: mid(r)[1])]
    while len(order) < len(rungs):
        order.append(next(iter(links[order[-1]] - set(order))))
    return [[round(float(x), 1), round(float(y), 1)] for x, y in (mid(r) for r in order)]


def to_lnglat(point, anchor):
    dx, dy = point[0] - anchor['x'], point[1] - anchor['y']
    lat = anchor['lat'] + dy / 110540
    lng = anchor['lng'] + dx / (111320 * math.cos(math.radians(anchor['lat'])))
    return [round(lng, 7), round(lat, 7)]


def write_route(route, anchor):
    names = {0: '北', 90: '东', 180: '南', 270: '西'}
    steps, prev = [], None
    for i in range(len(route) - 1):
        (x0, y0), (x1, y1) = route[i], route[i + 1]
        dist = math.hypot(x1 - x0, y1 - y0)
        bearing = math.degrees(math.atan2(x1 - x0, y1 - y0)) % 360
        facing = names[int(round(bearing / 90)) % 4 * 90]
        if prev is None:
            text, action = f'从{START_NAME}出发，向{facing}直行约 {dist:.0f} 米', 'straight'
        else:
            turn = (bearing - prev + 540) % 360 - 180
            action = 'turn_right' if turn > 0 else 'turn_left'
            text = f'{"右" if turn > 0 else "左"}转，向{facing}直行约 {dist:.0f} 米'
        if i == len(route) - 2:
            text += f'，到达{DEST_NAME}'
        prev = bearing
        steps.append({'index': i, 'instruction': text, 'distance_m': round(dist, 1), 'action': action,
                      'end': to_lnglat(route[i + 1], anchor)})
    total = round(sum(s['distance_m'] for s in steps), 1)
    data = {
        'route_id': 'demo-city', 'mode': 'outdoor', 'coord': 'gcj02',
        'destination_name': DEST_NAME, 'aliases': ['演示路线', '演示城市', '城市演示'],
        'sample': True, 'note': '虚构演示城市路线（来自 Blender 场景），非真实街道',
        'cached': True, 'distance_m': total, 'duration_s': round(total / 1.2),
        'polyline': [to_lnglat(p, anchor) for p in route], 'steps': steps,
        'robot_plan': None, 'current_step': 0,
    }
    path = BACKEND / 'data' / 'demo_routes' / 'city_demo.json'
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    sys.exit(main())
