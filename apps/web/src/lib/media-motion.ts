/**
 * Shared motion contract for the media modules (album lightbox, video player).
 * globals.css owns the values; WAAPI reads them from computed style so CSS and
 * script never drift. A missing or invalid token yields 0, which callers treat
 * as "do not animate" — content is always left in its final, usable state.
 */
export type MediaMotionTokens = {
  control: number;
  panel: number;
  media: number;
  emphasis: number;
  reduced: number;
  panelDistance: number;
  ease: string;
};

type StyleSource = { getPropertyValue(name: string): string };

/** Parses a CSS <time> ("180ms", "0.18s"); anything else is null. */
export function parseMotionDuration(value: string): number | null {
  const match = value.trim().match(/^(-?\d*\.?\d+)(ms|s)$/i);
  if (!match) return null;
  const amount = Number(match[1]) * (match[2].toLowerCase() === "s" ? 1000 : 1);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function motionTokensFrom(style: StyleSource): MediaMotionTokens {
  const time = (name: string) => parseMotionDuration(style.getPropertyValue(name)) ?? 0;
  return {
    control: time("--motion-control-duration"),
    panel: time("--motion-panel-duration"),
    media: time("--motion-media-duration"),
    emphasis: time("--motion-emphasis-duration"),
    reduced: time("--motion-reduced-duration"),
    panelDistance: parseFloat(style.getPropertyValue("--motion-panel-distance")) || 0,
    ease: style.getPropertyValue("--motion-ease").trim() || "ease-out",
  };
}

export function readMotionTokens(element: Element): MediaMotionTokens {
  return motionTokensFrom(getComputedStyle(element));
}

export function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** WAAPI where it exists and is usable; null means "apply the end state instead". */
export function animateElement(
  element: Element | null | undefined,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (!element || typeof element.animate !== "function" || !(Number(options.duration) > 0)) {
    return null;
  }
  try {
    return element.animate(keyframes, options);
  } catch {
    // Partial implementations (e.g. no pseudo-element targets) fall back to the final state.
    return null;
  }
}
