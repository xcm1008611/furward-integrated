export type DemoStatus = 'IDLE' | 'ACTIVE' | 'PAUSED' | 'DONE' | 'CANCELLED';
export type DemoAction = 'start' | 'pause' | 'resume' | 'cancel' | 'reset' | 'obstacle' | 'obstacle_bypass' | 'obstacle_clear';
export type WorldPoint = { x: number; y: number; z: number };
export type DemoNavigation = { points: WorldPoint[]; total_distance_m: number; step_end_distances: number[] };
export type DemoObstacle = { id: string; point: WorldPoint; heading: number };
export type DemoMapTransform = { planar: ['x', '-z']; clockwise_degrees: number; rotated_origin: [number, number]; description?: string };
export const GUIDE_FOLLOW_DISTANCE_M = 2.2;
export type DemoState = {
  session_id: string;
  revision: number;
  status: DemoStatus;
  distance_m: number;
  current_step: number;
  pause_reason: string | null;
  obstacle_active: boolean;
  obstacle_triggered: boolean;
  navigation: DemoNavigation;
  obstacles: DemoObstacle[];
  detour_until_m: number | null;
  message: string;
};
export type DemoIdentity = { session_id: string; token: string };
export type DemoWorld = {
  version: number;
  coordinate_system: string;
  route: {
    route_id: string;
    points: WorldPoint[];
    steps: { index: number; instruction: string; action: string; start_m: number; end_m: number; distance_m: number }[];
    total_distance_m: number;
    speed_mps: number;
    start_name: string;
    destination_name: string;
    obstacle_distance_m: number;
  };
  assets: { city: string; periphery: string; human: string; dog: string };
  transform: DemoMapTransform;
  map?: { width_m: number; height_m: number; route: number[][]; roads: number[][][]; walks: number[][][]; buildings: { poly: number[][]; h: number }[] };
};

export const STATUS_LABELS: Record<DemoStatus, string> = {
  IDLE: '准备出发', ACTIVE: '正在引导', PAUSED: '已停下', DONE: '已到达', CANCELLED: '本次已结束',
};

/** Loading and older in-flight snapshots can use the original route until navigation arrives. */
export function navigationForState(world: DemoWorld, state: DemoState | null): DemoNavigation {
  return state?.navigation ?? {
    points: world.route.points,
    total_distance_m: world.route.total_distance_m,
    step_end_distances: world.route.steps.map(step => step.end_m),
  };
}

/** Exact inverse of export-world.py; map coordinates use +Y up, SVG flips Y once. */
export function worldToMapPoint(point: WorldPoint, transform: DemoMapTransform): [number, number] {
  const angle = transform.clockwise_degrees * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c * point.x - s * point.z - transform.rotated_origin[0],
    -s * point.x - c * point.z - transform.rotated_origin[1]];
}

/** Positions and headings share the same arc-length metric, including at corners. */
export function pointAtDistance(points: WorldPoint[], distance: number, extendStart = false) {
  if (points.length < 2) return { point: points[0] ?? { x: 0, y: 0, z: 0 }, heading: 0 };
  let remaining = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (length < 0.0001) continue;
    if (remaining <= length || i === points.length - 1) {
      const t = Math.min(1, Math.max(extendStart && i === 1 ? -1 : 0, remaining / length));
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t },
        heading: Math.atan2(b.x - a.x, b.z - a.z),
      };
    }
    remaining -= length;
  }
  return { point: points[points.length - 1], heading: 0 };
}

export function angleDifference(target: number, current: number) {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}
