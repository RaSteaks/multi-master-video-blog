/** Shared timing for the animated home diagrams, in seconds since the drawing began. */

import { ease } from "./color-math";

/** The default still for an ambient diagram, with any morph fully arrived. */
export const STILL_SECONDS = 5.5;

const MORPH_PERIOD = 9;

export type DiagramFrame = { seconds: number; label: string };

export function morphFrames(from: string, to: string): DiagramFrame[] {
  return [{ seconds: 0, label: from }, { seconds: STILL_SECONDS, label: to }];
}

export function cycleFrames(period: number, labels: readonly string[]): DiagramFrame[] {
  // Sample each stage before its transition, including when the cycle uses a fade.
  return labels.map((label, index) => ({ seconds: period * (index + 0.5), label }));
}

export function sweepFrames(period: number, labels: readonly [string, string, string]): DiagramFrame[] {
  // Only the outward half is needed to show both ends and the midpoint.
  return labels.map((label, index) => ({ seconds: period * index / 4, label }));
}

/** Rests at 0, eases to 1, rests, eases back: one 9 s round trip. */
export function morph(seconds: number) {
  const t = ((seconds % MORPH_PERIOD) + MORPH_PERIOD) % MORPH_PERIOD;
  return t < 7 ? ease(t, 1.5, 4) : 1 - ease(t, 7, 9);
}

/** Steps through `count` items, `period` seconds each; `blend` eases into the next over the last `fade` seconds. */
export function cycle(seconds: number, period: number, count: number, fade = 0) {
  const position = Math.max(0, seconds) / period;
  const index = Math.floor(position) % count;
  const within = (position % 1) * period;
  return { index, next: (index + 1) % count, blend: fade > 0 ? ease(within, period - fade, period) : 0 };
}

/** There and back again over `period` seconds, eased at each end. */
export function sweep(seconds: number, period: number) {
  const t = ((seconds / period) % 1 + 1) % 1;
  return ease(t < 0.5 ? t * 2 : 2 - t * 2);
}
