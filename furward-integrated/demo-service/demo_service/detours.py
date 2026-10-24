"""Small, conservative detours on a verified straight section of the demo route.

The existing route is authoritative. Only an untravelled 12m straight section
may be replaced; the collider footprints come from the delivered city asset.
This is a fixed-scene demonstration, not a general navigation or robot planner.
"""
from __future__ import annotations

import bisect
import copy
import math
from dataclasses import dataclass

DETOUR_SPAN_M = 12.0
LATERAL_OFFSET_M = 2.4
OBSTACLE_AHEAD_M = 5.0
FOLLOW_DISTANCE_M = 2.2
STRAIGHT_ROOM_M = 15.0
ACTOR_CLEARANCE_M = 0.65
SAMPLES = 64
EPS = 1e-7


class NoDetourSpace(ValueError):
    pass


def length(a: dict, b: dict) -> float:
    return math.sqrt(sum((b[key] - a[key]) ** 2 for key in ('x', 'y', 'z')))


def distances(points: list[dict]) -> list[float]:
    values = [0.0]
    for a, b in zip(points, points[1:]):
        values.append(values[-1] + length(a, b))
    return values


def point_at(points: list[dict], distance: float) -> tuple[dict, tuple[float, float], int]:
    cumulative = distances(points)
    distance = min(max(0, distance), cumulative[-1])
    index = min(bisect.bisect_right(cumulative, distance + EPS) - 1, len(points) - 2)
    a, b = points[index:index + 2]
    segment = cumulative[index + 1] - cumulative[index]
    ratio = min(1, max(0, (distance - cumulative[index]) / segment))
    point = {key: a[key] + (b[key] - a[key]) * ratio for key in ('x', 'y', 'z')}
    planar = math.hypot(b['x'] - a['x'], b['z'] - a['z'])
    return point, ((b['x'] - a['x']) / planar, (b['z'] - a['z']) / planar), index


def initial_navigation(world: dict) -> dict:
    return {'points': copy.deepcopy(world['route']['points']),
            'total_distance_m': round(distances(world['route']['points'])[-1], 4),
            'step_end_distances': [float(step['end_m']) for step in world['route']['steps']]}


def point_segment_distance(p, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    factor = min(1, max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz))) if dx or dz else 0
    return math.hypot(p[0] - a[0] - factor * dx, p[1] - a[1] - factor * dz)


def inside(point, polygon):
    hit = False
    x, z = point
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if ((a[1] > z) != (b[1] > z)) and x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]:
            hit = not hit
    return hit


def segment_distance(a, b, c, d):
    def cross(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    # Crossings of arbitrarily thin colliders must not fall between samples.
    if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0:
        return 0.0
    return min(point_segment_distance(a, c, d), point_segment_distance(b, c, d),
               point_segment_distance(c, a, b), point_segment_distance(d, a, b))


def path_clearance(points: list[dict], polygons: list) -> float:
    path = [(point['x'], point['z']) for point in points]
    min_x, max_x = min(p[0] for p in path), max(p[0] for p in path)
    min_z, max_z = min(p[1] for p in path), max(p[1] for p in path)

    def box_distance(polygon):
        dx = max(0, min(p[0] for p in polygon) - max_x, min_x - max(p[0] for p in polygon))
        dz = max(0, min(p[1] for p in polygon) - max_z, min_z - max(p[1] for p in polygon))
        return math.hypot(dx, dz)

    result = math.inf
    # Bounding boxes provide a conservative lower bound, never an exemption
    # from checking a nearby thin collider's edges.
    for lower_bound, polygon in sorted(((box_distance(p), p) for p in polygons), key=lambda item: item[0]):
        if lower_bound >= result:
            continue
        if any(inside(point, polygon) for point in path):
            return 0.0
        for a, b in zip(path, path[1:]):
            for c, d in zip(polygon, polygon[1:] + polygon[:1]):
                result = min(result, segment_distance(a, b, c, d))
    return result


def obstacle_polygon(obstacle: dict) -> list:
    point, heading = obstacle['point'], obstacle['heading']
    right, forward = (math.cos(heading), -math.sin(heading)), (math.sin(heading), math.cos(heading))
    return [[point['x'] + side * right[0] + along * forward[0],
             point['z'] + side * right[1] + along * forward[1]]
            for side, along in ((-.725, -.175), (.725, -.175), (.725, .175), (-.725, .175))]


@dataclass(frozen=True)
class DetourPlan:
    navigation: dict
    obstacle: dict
    until_m: float


def plan_detour(world: dict, navigation: dict, at_m: float, obstacles: list[dict], obstacle_id: str) -> DetourPlan:
    points = navigation['points']
    cumulative = distances(points)
    start, (dx, dz), index = point_at(points, at_m)
    # Do not bridge a corner, bend an earlier detour again, or run out of room
    # before the following person has returned to the original route.
    if cumulative[index + 1] - at_m < STRAIGHT_ROOM_M - EPS:
        raise NoDetourSpace('前方接近转弯或终点，空间不足，走到下一段直路后再模拟障碍。')
    blockers = world.get('detour_blockers')
    if blockers is None:
        raise NoDetourSpace('城市净空数据未载入，暂时不能规划绕行。')
    obstacle_point, _, _ = point_at(points, at_m + OBSTACLE_AHEAD_M)
    obstacle = {'id': obstacle_id, 'point': obstacle_point, 'heading': math.atan2(dx, dz)}
    obstacle_polygons = [obstacle_polygon(item) for item in obstacles + [obstacle]]
    end, _, _ = point_at(points, at_m + DETOUR_SPAN_M)
    choices = []
    for sign in (1, -1):
        curve = []
        for sample in range(SAMPLES + 1):
            u = sample / SAMPLES
            offset = sign * LATERAL_OFFSET_M * math.sin(math.pi * u) ** 2
            curve.append({'x': start['x'] + (end['x'] - start['x']) * u + dz * offset,
                          'y': start['y'] + (end['y'] - start['y']) * u,
                          'z': start['z'] + (end['z'] - start['z']) * u - dx * offset})
        clearance = path_clearance(curve, blockers)
        if clearance >= ACTOR_CLEARANCE_M and path_clearance(curve, obstacle_polygons) >= ACTOR_CLEARANCE_M:
            choices.append((clearance, curve))
    if not choices:
        raise NoDetourSpace('左右两侧都没有足够净空，不能在这里添加可绕行的障碍。')
    _, curve = max(choices, key=lambda choice: choice[0])
    replacement = ([copy.deepcopy(point) for point, distance in zip(points, cumulative) if distance < at_m - EPS]
                   + curve
                   + [copy.deepcopy(point) for point, distance in zip(points, cumulative) if distance > at_m + DETOUR_SPAN_M + EPS])
    extra = distances(curve)[-1] - DETOUR_SPAN_M
    total = round(navigation['total_distance_m'] + extra, 4)
    boundaries = [round(end_m + extra, 4) if end_m > at_m + EPS else end_m
                  for end_m in navigation['step_end_distances']]
    boundaries[-1] = total
    return DetourPlan({'points': replacement, 'total_distance_m': total, 'step_end_distances': boundaries},
                      obstacle, round(at_m + distances(curve)[-1] + FOLLOW_DISTANCE_M, 4))
