export const AUTHOR_TRAY_INNER_RATIO = 0.36;
const MAX_RADIUS = 176;
// Labels keep their size, so below this a two-line label meets the blade edges.
const MIN_RADIUS = 170;
const EDGE_MARGIN = 12;

export type AuthorTrayPoint = { x: number; y: number };
export type AuthorTrayLayout = AuthorTrayPoint & { radius: number };

/** Keep the real cursor at the center. Near an edge, wait for an inward move
 * instead of shifting the center or shrinking the labels beyond readability. */
export function authorTrayLayout(point: AuthorTrayPoint, width: number, height: number): AuthorTrayLayout | null {
  const radius = Math.floor(Math.min(MAX_RADIUS, point.x - EDGE_MARGIN, width - point.x - EDGE_MARGIN,
    point.y - EDGE_MARGIN, height - point.y - EDGE_MARGIN));
  return radius < MIN_RADIUS ? null : { ...point, radius };
}

type Point = [number, number];

const HOLE_RADIUS = 50 * AUTHOR_TRAY_INNER_RATIO;
const RIM = 52; // Past the visible edge, so rotating blades never expose it.
const LABEL_RIM = 45;
const CURVE_STEPS = 20;
const TWIST = 45.5; // Degrees a blade edge travels from the opening to the rim.
const HOLE_CURVE = 1.09; // Arcs slightly flatter than the circle leave faint corners.

const toPoint = (angle: number, radius: number): Point => {
  const radians = angle * Math.PI / 180;
  return [50 + radius * Math.cos(radians), 50 + radius * Math.sin(radians)];
};
const format = ([x, y]: Point) => `${x.toFixed(3)} ${y.toFixed(3)}`;

/** One blade edge: it leaves the opening along its tangent, as real iris
 * blades do, then sweeps out to the rim. */
function bladeEdge(angle: number) {
  const start = toPoint(angle, HOLE_RADIUS);
  const tangent = (angle + 90) * Math.PI / 180;
  const c1: Point = [start[0] + Math.cos(tangent) * HOLE_RADIUS * 0.62, start[1] + Math.sin(tangent) * HOLE_RADIUS * 0.62];
  const c2 = toPoint(angle + TWIST * 0.886, (HOLE_RADIUS + 50) * 0.62);
  const end = toPoint(angle + TWIST, RIM);
  return { start, c1, c2, end };
}

function pointsOnEdge(angle: number) {
  const { start, c1, c2, end } = bladeEdge(angle);
  return Array.from({ length: CURVE_STEPS + 1 }, (_, index): Point => {
    const t = index / CURVE_STEPS, u = 1 - t;
    const on = (axis: 0 | 1) => u * u * u * start[axis] + 3 * u * u * t * c1[axis] + 3 * u * t * t * c2[axis] + t * t * t * end[axis];
    return [on(0), on(1)];
  });
}

/** Closed blade outline, from its edge at the opening round to the next edge. */
function bladeOutline(angle: number, step: number): Point[] {
  const rim = Array.from({ length: 9 }, (_, index) => toPoint(angle + TWIST + step * index / 8, RIM));
  const hole = Array.from({ length: 7 }, (_, index) => toPoint(angle + step - step * index / 6, HOLE_RADIUS));
  return [...pointsOnEdge(angle), ...rim, ...pointsOnEdge(angle + step).reverse(), ...hole];
}

export function pointInPolygon([x, y]: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The label sits on the blade's visual center. Sampling is exact enough here
 * and stays correct for any blade count, unlike a fixed label radius. */
function bladeCenter(outline: Point[]): Point {
  let x = 0, y = 0, count = 0;
  for (let px = 0; px <= 100; px++) for (let py = 0; py <= 100; py++) {
    if (Math.hypot(px - 50, py - 50) <= LABEL_RIM && pointInPolygon([px, py], outline)) { x += px; y += py; count++; }
  }
  return count ? [x / count, y / count] : [50, 50];
}

/** Six-or-so iris blades. Percentage polygons give HTML Links true hit areas
 * matching each blade; SVG anchors would bypass the site's HTML-link
 * navigation and unsaved-edit guards. The first action stays at twelve o'clock. */
export function authorTrayBlades(count: number) {
  if (count < 1) return { blades: [], hole: "" };
  const step = 360 / count;
  const [firstX, firstY] = bladeCenter(bladeOutline(0, step));
  const spin = -90 - Math.atan2(firstY - 50, firstX - 50) * 180 / Math.PI;
  const angleOf = (index: number) => spin + index * step;
  const blades = Array.from({ length: count }, (_, index) => {
    const outline = bladeOutline(angleOf(index), step);
    const [labelX, labelY] = bladeCenter(outline);
    const edge = ({ start, c1, c2, end }: ReturnType<typeof bladeEdge>) => `M${format(start)} C${format(c1)} ${format(c2)} ${format(end)}`;
    return {
      outline, labelX, labelY,
      clipPath: `polygon(${outline.map(([x, y]) => `${x.toFixed(3)}% ${y.toFixed(3)}%`).join(", ")})`,
      // The drawn blade runs on under the opening, so the iris can close over it.
      fill: `M50 50 L${[...pointsOnEdge(angleOf(index)), ...outline.slice(CURVE_STEPS + 1, -7)].map(format).join(" L")} Z`,
      edge: edge(bladeEdge(angleOf(index))),
      nextEdge: edge(bladeEdge(angleOf(index + 1))),
    };
  });
  const arc = HOLE_RADIUS * HOLE_CURVE;
  const hole = `M${format(toPoint(angleOf(0), HOLE_RADIUS))}${Array.from({ length: count }, (_, index) =>
    ` A${arc.toFixed(3)} ${arc.toFixed(3)} 0 0 1 ${format(toPoint(angleOf(index + 1), HOLE_RADIUS))}`).join("")} Z`;
  return { blades, hole };
}
