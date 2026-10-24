import heapq
import json
import math
from pathlib import Path

from app.config import Settings
from app.errors import ApiError, NOT_FOUND, NO_ROUTE
from app.models import Command, Route, RouteStep


def data_path(path: str) -> Path:
    value = Path(path)
    return value if value.is_absolute() else Path(__file__).resolve().parents[2] / value


def normalize_angle(angle):
    return (angle + 180) % 360 - 180


class IndoorMap:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.data = json.loads(data_path(settings.indoor_map_path).read_text(encoding='utf-8'))
        self.waypoints = self.data['waypoints']
        self.start_waypoint = self.data['start_waypoint']
        self.start_heading_deg = self.data['start_heading_deg']

    def find(self, value):
        for key, waypoint in self.waypoints.items():
            if value in [key, waypoint['name'], *waypoint.get('aliases', [])]:
                return key
        names = '、'.join(w['name'] for key, w in self.waypoints.items() if key != self.start_waypoint)
        raise ApiError(NOT_FOUND, f'没有找到"{value}"，可以去：{names}', 404)

    def point(self, key):
        waypoint = self.waypoints[self.find(key)]
        return waypoint['x'], waypoint['y']

    def plan(self, from_id, to_id, heading_deg) -> Route:
        start, end = self.find(from_id), self.find(to_id)
        graph = {key: [] for key in self.waypoints}
        for a, b in self.data['edges']:
            distance = math.dist(self.point(a), self.point(b))
            graph[a].append((b, distance))
            graph[b].append((a, distance))
        queue, best = [(0.0, start, [start])], {start: 0.0}
        path = None
        while queue:
            distance, node, nodes = heapq.heappop(queue)
            if distance > best[node]:
                continue
            if node == end:
                path = nodes
                break
            for neighbor, weight in graph[node]:
                candidate = distance + weight
                if candidate < best.get(neighbor, math.inf):
                    best[neighbor] = candidate
                    heapq.heappush(queue, (candidate, neighbor, nodes + [neighbor]))
        if path is None:
            raise ApiError(NO_ROUTE, '航点之间没有连通路线')
        steps, commands = [], []
        duration = 0.0
        for a, b in zip(path, path[1:]):
            p, q = self.point(a), self.point(b)
            length = math.dist(p, q)
            if length == 0:
                continue
            heading = math.degrees(math.atan2(q[1]-p[1], q[0]-p[0]))
            angle = normalize_angle(heading-heading_deg)
            cmds, text, action = [], '', 'straight'
            if abs(angle) >= self.settings.nav_turn_threshold_deg and abs(angle) > 1e-9:
                action = 'turn_left' if angle > 0 else 'turn_right'
                text = f'{"左" if angle > 0 else "右"}转 {abs(angle):g}°，'
                remaining = angle
                while abs(remaining) > 1e-9:
                    part = math.copysign(min(abs(remaining), self.settings.max_turn_deg), remaining)
                    cmds.append(Command(name='turn', args={'angle_deg': part}))
                    remaining -= part
                duration += abs(math.radians(angle)) / self.settings.angular_speed
                heading_deg = heading
            remaining = length
            while remaining > 1e-9:
                part = min(remaining, self.settings.max_move_m)
                cmds.append(Command(name='move', args={'distance_m': part}))
                remaining -= part
            duration += length / self.settings.linear_speed
            steps.append(RouteStep(index=len(steps), instruction=f'{text}直行 {length:.1f} 米，到达{self.waypoints[b]["name"]}', distance_m=length, action=action, end=q, robot_cmds=cmds))
            commands.extend(cmds)
        return Route(mode='indoor', coord='local_m', distance_m=best[end], duration_s=duration, polyline=[self.point(node) for node in path], steps=steps, robot_plan=commands, destination_name=self.waypoints[end]['name'])
