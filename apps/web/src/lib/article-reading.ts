export type ArticleHeadingPosition = { id: string; top: number };

/** Keep the last crossed heading active even when a long section has no visible heading. */
export function currentArticleHeading(
  headings: readonly ArticleHeadingPosition[],
  readingLine: number,
  atArticleEnd = false,
): string | null {
  if (!headings.length) return null;
  // The final heading may never reach the reading line when the last section is short.
  if (atArticleEnd) return headings[headings.length - 1].id;

  let current = headings[0].id;
  for (const heading of headings) {
    if (heading.top > readingLine + 1) break;
    current = heading.id;
  }
  return current;
}

/** Scroll offset that centres an item in its scroll container, clamped at the start and end. */
export function centeredScrollTop({
  itemTop,
  itemHeight,
  viewportHeight,
  scrollHeight,
}: {
  /** Item top in the container's content coordinates (i.e. including current scrollTop). */
  itemTop: number;
  itemHeight: number;
  viewportHeight: number;
  scrollHeight: number;
}) {
  const max = Math.max(0, scrollHeight - viewportHeight);
  const target = itemTop + itemHeight / 2 - viewportHeight / 2;
  return Math.round(Math.min(max, Math.max(0, target)));
}

/**
 * CSS cubic-bezier() timing function: maps animation progress (x) to eased progress (y).
 * Newton–Raphson with a bisection fallback, accurate to well under a pixel of scroll.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  function solveT(x: number) {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let low = 0;
    let high = 1;
    t = x;
    for (let i = 0; i < 40 && high - low > 1e-7; i += 1) {
      if (sampleX(t) < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return t;
  }

  return (progress: number) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    return sampleY(solveT(progress));
  };
}

/** Page-scroll duration for a TOC jump: short hops are quick, long jumps a little longer. */
export function articleScrollDuration(distancePx: number) {
  const distance = Math.abs(distancePx);
  if (distance < 2) return 0;
  return Math.round(Math.min(900, 280 + 7 * Math.sqrt(distance)));
}

/**
 * The reading motion curve shared by the page jump, the TOC list and its indicator: a brief
 * ease-in so nothing lurches, then a long ease-out so motion settles softly.
 */
export const READING_EASE = [0.45, 0, 0.15, 1] as const;

/** TOC list scroll and indicator duration: short hops are brisk, long ones a little longer. */
export function tocMotionDuration(distancePx: number) {
  const distance = Math.abs(distancePx);
  if (distance < 1) return 0;
  return Math.round(Math.min(600, 220 + 6 * Math.sqrt(distance)));
}

/**
 * Curve for a motion that starts while already moving: the first control point is set so
 * the curve's initial slope equals the current velocity, so a retarget never stalls. From
 * rest, or when reversing, it is READING_EASE itself.
 */
export function retargetEase(
  velocityPxPerMs: number,
  distancePx: number,
  durationMs: number,
): readonly [number, number, number, number] {
  const [x1, y1, x2, y2] = READING_EASE;
  if (!(durationMs > 0) || Math.abs(distancePx) < 1) return [x1, y1, x2, y2];
  // Normalised slope: current speed relative to the average speed of the new motion.
  const slope = (velocityPxPerMs * durationMs) / distancePx;
  if (!(slope > 0)) return [x1, y1, x2, y2];
  // x2 must sit right of x1: reusing READING_EASE's 0.15 folds the control polygon back and
  // the speed spikes, then dips, a few frames after the retarget.
  const matchedX1 = 0.2;
  return [matchedX1, Math.min(1, matchedX1 * slope), Math.max(x2, 0.4), y2];
}

/**
 * Spatial easing for the TOC indicator's handoff: symmetric, so the indicator leaves one
 * entry and settles on the next gently. Applied to scroll distance, not to time.
 */
export const HANDOFF_EASE = [0.65, 0, 0.35, 1] as const;

export type ReadingHandoff = { index: number; next: number | null; progress: number };

/**
 * Scroll-linked position of the TOC indicator. `crossings[j]` is the page scroll offset at
 * which heading j reaches the reading line (clamped to where the article end becomes
 * visible). The indicator rests on the current entry and slides to the next one across the
 * last `zone` px of scrolling before that heading crosses — or the whole section if shorter.
 */
export function readingHandoff(crossings: readonly number[], scroll: number, zone: number): ReadingHandoff | null {
  if (!crossings.length) return null;
  let index = 0;
  for (let j = 0; j < crossings.length; j += 1) {
    if (crossings[j] > scroll + 1) break;
    index = j;
  }
  const next = index + 1 < crossings.length ? index + 1 : null;
  if (next === null) return { index, next: null, progress: 0 };
  const span = Math.min(zone, crossings[next] - crossings[index]);
  const remaining = crossings[next] - scroll;
  const progress = span > 0 ? Math.max(0, Math.min(1, 1 - remaining / span)) : 0;
  return { index, next, progress };
}
