import { GUIDE_FOLLOW_DISTANCE_M, navigationForState, pointAtDistance, worldToMapPoint, type DemoWorld, type DemoState } from '@/lib/demo-types';
import styles from './routeMap.module.css';

/** Shared by the 3D minimap and the accessible page; markerScale enlarges people and obstacles for low vision. */
export default function RouteMap({ world, state, markerScale = 1, large = false }: { world: DemoWorld; state: DemoState | null; markerScale?: number; large?: boolean }) {
  const map = world.map;
  if (!map) return null;
  const navigation = navigationForState(world, state);
  const toMap = (point: DemoWorld['route']['points'][number]) => worldToMapPoint(point, world.transform);
  const points = navigation.points.map(toMap);
  const dogPose = pointAtDistance(navigation.points, state?.distance_m ?? 0);
  const dog = toMap(dogPose.point);
  const human = toMap(pointAtDistance(navigation.points, (state?.distance_m ?? 0) - GUIDE_FOLLOW_DISTANCE_M, true).point);
  const headingAngle = (point: DemoWorld['route']['points'][number], heading: number) => {
    const from = toMap(point);
    const to = toMap({ ...point, x: point.x + Math.sin(heading), z: point.z + Math.cos(heading) });
    return Math.atan2(from[1] - to[1], to[0] - from[0]) * 180 / Math.PI;
  };
  // Keep the same useful map extent through replanning, with room for the detour.
  const original = world.route.points.map(toMap);
  const left = Math.max(0, Math.min(...original.map(point => point[0])) - 18);
  const right = Math.min(map.width_m, Math.max(...original.map(point => point[0])) + 18);
  const bottom = Math.max(0, Math.min(...original.map(point => point[1])) - 18);
  const top = Math.min(map.height_m, Math.max(...original.map(point => point[1])) + 18);
  const pointList = (poly: number[][]) => poly.map(([x, y]) => `${x},${map.height_m - y}`).join(' ');
  const scale = `scale(${markerScale})`;
  return <><svg className={styles.routeMap} viewBox={`${left} ${map.height_m - top} ${right - left} ${top - bottom}`} role="img" aria-label={`路线简图，${world.route.start_name}前往${world.route.destination_name}，显示当前路线、人和机器狗，以及 ${state?.obstacles?.length ?? 0} 处固定障碍`}>
    <rect width={map.width_m} height={map.height_m} fill="#eeefe8" />
    {map.roads.map((poly, index) => <polygon key={`r${index}`} points={pointList(poly)} fill="#dbdcd4" />)}
    {map.walks.map((poly, index) => <polygon key={`w${index}`} points={pointList(poly)} fill="#fafbf7" />)}
    {map.buildings.map((building, index) => <polygon key={`b${index}`} points={pointList(building.poly)} fill="#b8bbae" />)}
    <polyline points={pointList(points)} fill="none" stroke="#353b29" strokeWidth="2" strokeLinejoin="round" />
    <polyline points={pointList(points)} fill="none" stroke="#d2ff00" strokeWidth="0.9" strokeLinejoin="round" />
    <circle cx={points[0][0]} cy={map.height_m - points[0][1]} r="1.5" fill="#353b29" />
    <circle cx={points[points.length - 1][0]} cy={map.height_m - points[points.length - 1][1]} r="2.3" fill="#fafbf7" stroke="#353b29" strokeWidth="1" />
    {state?.obstacles?.map(obstacle => {
      const point = toMap(obstacle.point);
      return <g key={obstacle.id} data-map-obstacle={obstacle.id} transform={`translate(${point[0]} ${map.height_m - point[1]}) rotate(${headingAngle(obstacle.point, obstacle.heading)}) ${scale}`}>
        <rect x="-0.8" y="-2.5" width="1.6" height="5" rx="0.3" fill="#73511e" stroke="#fff" strokeWidth="0.6" />
      </g>;
    })}
    <circle data-map-character="human" cx={0} cy={0} r="1.3" transform={`translate(${human[0]} ${map.height_m - human[1]}) ${scale}`} fill="#fff" stroke="#25281f" strokeWidth="0.9" />
    <path data-map-character="dog" d="M 2.1 0 L -1.2 -1.3 L -0.65 0 L -1.2 1.3 Z" transform={`translate(${dog[0]} ${map.height_m - dog[1]}) rotate(${headingAngle(dogPose.point, dogPose.heading)}) ${scale}`} fill="#d2ff00" stroke="#25281f" strokeWidth="0.7" strokeLinejoin="round" />
  </svg><div className={styles.mapLegend} data-large={large || undefined} aria-hidden="true"><span><i className={styles.mapDog} />狗</span><span><i className={styles.mapHuman} />人</span><span><i className={styles.mapObstacle} />障碍</span></div></>;
}
