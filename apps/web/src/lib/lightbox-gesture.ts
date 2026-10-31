/**
 * Pure decisions for the album lightbox's single-finger gestures. The component
 * owns pointer listeners and DOM writes; everything that decides what a gesture
 * means lives here so it can be tested without a browser.
 *
 * Paging wraps around (the lightbox loops), so there is deliberately no edge
 * resistance: a swipe past the last photo is an ordinary "next".
 */
export const LIGHTBOX_GESTURE = {
  /** Movement below this is a tap or jitter, never a gesture. */
  slopPx: 10,
  /** The dominant axis must lead the other by this factor before locking. */
  axisRatio: 1.15,
  /** A fast flick still has to travel this far, so a tap with a twitch never pages. */
  minFlickPx: 24,
  swipeDistanceRatio: 0.22,
  swipeMinPx: 72,
  swipeVelocity: 0.45,
  dismissDistanceRatio: 0.18,
  dismissMinPx: 96,
  dismissVelocity: 0.5,
  /** Velocity is the slope across this recent window. */
  velocityWindowMs: 100,
  /** If the finger rested this long before lifting, the release has no momentum. */
  restMs: 80,
  /** Samples closer than this give noisy slopes; treat as no momentum. */
  minSampleSpanMs: 12,
  /** Coalesced/glitched events can produce absurd slopes; clamp them (px/ms). */
  maxVelocity: 4,
  /** Scale reached at a full-height pull-down. */
  dismissMinScale: 0.86,
} as const;

export type GestureAxis = "x" | "y" | "none";
export type GestureOutcome = "next" | "previous" | "dismiss" | "return";

/**
 * Decides the gesture axis once movement leaves the slop circle.
 * null: still undecided. "none": not ours (upward drag, or paging with one photo).
 */
export function lockGestureAxis(
  dx: number,
  dy: number,
  { canPage }: { canPage: boolean },
): GestureAxis | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.hypot(dx, dy) < LIGHTBOX_GESTURE.slopPx) return null;
  if (ax >= ay * LIGHTBOX_GESTURE.axisRatio) return canPage ? "x" : "none";
  if (ay >= ax * LIGHTBOX_GESTURE.axisRatio) return dy > 0 ? "y" : "none";
  // Diagonal: wait for one axis to dominate rather than guessing.
  return Math.hypot(dx, dy) > LIGHTBOX_GESTURE.slopPx * 3 ? "none" : null;
}

/** Offset along the locked axis, minus the slop so the photo does not jump at lock. */
export function axisOffset(delta: number) {
  const slop = LIGHTBOX_GESTURE.slopPx;
  if (Math.abs(delta) <= slop) return 0;
  return delta - Math.sign(delta) * slop;
}

type Sample = { t: number; x: number; y: number };

export function createVelocityTracker() {
  let samples: Sample[] = [];
  return {
    reset() {
      samples = [];
    },
    add(t: number, x: number, y: number) {
      samples.push({ t, x, y });
      const cutoff = t - LIGHTBOX_GESTURE.velocityWindowMs * 2;
      while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
    },
    /** px/ms at release time `now`; zero when the finger rested or samples are too sparse. */
    velocity(now: number) {
      const last = samples[samples.length - 1];
      if (!last || now - last.t > LIGHTBOX_GESTURE.restMs) return { x: 0, y: 0 };
      const windowStart = last.t - LIGHTBOX_GESTURE.velocityWindowMs;
      const first = samples.find((sample) => sample.t >= windowStart) ?? last;
      const span = last.t - first.t;
      if (span < LIGHTBOX_GESTURE.minSampleSpanMs) return { x: 0, y: 0 };
      const clamp = (value: number) =>
        Math.max(-LIGHTBOX_GESTURE.maxVelocity, Math.min(LIGHTBOX_GESTURE.maxVelocity, value));
      return { x: clamp((last.x - first.x) / span), y: clamp((last.y - first.y) / span) };
    },
  };
}

/** Distance OR velocity commits; a flick must still clear minFlickPx and agree in direction. */
export function gestureOutcome({
  axis,
  offset,
  velocity,
  viewport,
}: {
  axis: GestureAxis;
  offset: number;
  velocity: number;
  viewport: number;
}): GestureOutcome {
  const G = LIGHTBOX_GESTURE;
  if (axis === "x") {
    const distance = Math.max(G.swipeMinPx, viewport * G.swipeDistanceRatio);
    const flick =
      Math.abs(velocity) >= G.swipeVelocity &&
      Math.abs(offset) >= G.minFlickPx &&
      Math.sign(velocity) === Math.sign(offset);
    if (Math.abs(offset) >= distance || flick) return offset < 0 ? "next" : "previous";
    return "return";
  }
  if (axis === "y") {
    const distance = Math.max(G.dismissMinPx, viewport * G.dismissDistanceRatio);
    const flick = velocity >= G.dismissVelocity && offset >= G.minFlickPx;
    // A pull that is being pushed back up is a change of mind, not a dismissal.
    if ((offset >= distance && velocity > -G.dismissVelocity) || flick) return "dismiss";
  }
  return "return";
}

/** 0..1 progress of a pull-down, used to fade chrome and scale the photo. */
export function dismissProgress(offsetY: number, viewportHeight: number) {
  if (!(viewportHeight > 0) || offsetY <= 0) return 0;
  return Math.min(1, offsetY / (viewportHeight * 0.5));
}

export function dismissScale(progress: number) {
  return 1 - (1 - LIGHTBOX_GESTURE.dismissMinScale) * Math.max(0, Math.min(1, progress));
}

export type LayerTransform = { x: number; y: number; scale: number };

export const IDENTITY_TRANSFORM: LayerTransform = { x: 0, y: 0, scale: 1 };

export function transformValue({ x, y, scale }: LayerTransform) {
  return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
}

/**
 * Reads translate/scale back from a computed `transform` (matrix or matrix3d), so a
 * gesture that grabs a photo mid-animation continues from where it is drawn.
 */
export function parseLayerTransform(value: string | null | undefined): LayerTransform {
  if (!value || value === "none") return { ...IDENTITY_TRANSFORM };
  const numbers = value.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
  if (value.startsWith("matrix3d(") && numbers.length >= 16) {
    // numbers[0] is the "3" of matrix3d.
    const m = numbers.slice(1);
    return { x: m[12] || 0, y: m[13] || 0, scale: Math.hypot(m[0], m[1]) || 1 };
  }
  if (value.startsWith("matrix(") && numbers.length >= 6) {
    const [a, b, , , e, f] = numbers;
    return { x: e || 0, y: f || 0, scale: Math.hypot(a, b) || 1 };
  }
  return { ...IDENTITY_TRANSFORM };
}

type Box = { left: number; top: number; width: number; height: number };

/** Transform (about the element's centre) that draws `from` over `to`. */
export function flipTransform(from: Box, to: Box): LayerTransform {
  return {
    x: to.left + to.width / 2 - (from.left + from.width / 2),
    y: to.top + to.height / 2 - (from.top + from.height / 2),
    scale: from.width > 0 ? to.width / from.width : 1,
  };
}

/** A uniform-scale morph only reads as the same photo when the shapes agree. */
export function aspectsMatch(a: Box, b: Box, tolerance = 0.04) {
  if (!(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) return false;
  const ratio = (a.width / a.height) / (b.width / b.height);
  return Math.abs(1 - ratio) <= tolerance;
}

/** Untransformed box of an element currently drawn with `transform` about its centre. */
export function untransformedBox(drawn: Box, transform: LayerTransform): Box {
  const scale = transform.scale || 1;
  const width = drawn.width / scale;
  const height = drawn.height / scale;
  const centerX = drawn.left + drawn.width / 2 - transform.x;
  const centerY = drawn.top + drawn.height / 2 - transform.y;
  return { left: centerX - width / 2, top: centerY - height / 2, width, height };
}

/** Whether a tile is on screen enough to morph into without scrolling the page. */
export function boxIsVisible(box: Box, viewport: { width: number; height: number }) {
  if (!(box.width >= 4 && box.height >= 4)) return false;
  const visibleWidth = Math.min(box.left + box.width, viewport.width) - Math.max(box.left, 0);
  const visibleHeight = Math.min(box.top + box.height, viewport.height) - Math.max(box.top, 0);
  return visibleWidth >= box.width * 0.5 && visibleHeight >= box.height * 0.5;
}

/** Duration for a committed swipe: carry the release speed, bounded by the media/panel tokens. */
export function swipeDuration(remainingPx: number, velocity: number, media: number, panel: number) {
  if (!(media > 0)) return 0;
  const speed = Math.abs(velocity);
  if (speed < 0.3) return media;
  return Math.round(Math.max(media * 0.67, Math.min(panel || media, remainingPx / speed)));
}
