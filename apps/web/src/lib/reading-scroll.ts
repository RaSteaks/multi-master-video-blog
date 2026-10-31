import { READING_EASE, articleScrollDuration, cubicBezier } from "./article-reading";

/**
 * Animated in-page jumps for the reading page (TOC entries, footnotes, in-article #links):
 * READING_EASE over a distance-based duration instead of the browser's fixed smooth
 * scrolling. One jump runs at a time; a new one takes over from wherever the page is.
 */
const READING_SCROLL_EASE = cubicBezier(...READING_EASE);
/** Keys that scroll the page; other keys (Enter on a link) are not the reader taking over. */
export const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

let cancelActive: (() => void) | null = null;

export function cancelReadingScroll() {
  cancelActive?.();
  cancelActive = null;
}

/** Plain primary clicks only; modified clicks keep the browser's link behaviour (new tab…). */
export function isPlainPrimaryClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Where a target sits when reached: its own scroll-margin-top, or — for targets without one,
 * such as footnotes — the article headings' reading line, so nothing lands under the header.
 */
function readingLine(target: Element) {
  const own = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  if (own > 0) return own;
  const heading = document.querySelector(".markdown-body :is(h1, h2, h3, h4, h5, h6)");
  const shared = heading ? Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0 : 0;
  if (shared > 0) return shared;
  const header = document.querySelector(".site-header");
  return header ? Math.max(0, header.getBoundingClientRect().bottom) + 24 : 0;
}

/**
 * Scrolls the page so `target` lands on its reading line. The destination is re-measured
 * every frame, so images loading above it cannot make the jump miss. Wheel, touch, scroll
 * keys or a pointer press elsewhere stop it where it is. Reduced motion lands directly.
 */
export function scrollPageToElement(target: Element) {
  cancelReadingScroll();
  const destination = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return Math.max(0, Math.min(max, target.getBoundingClientRect().top + window.scrollY - readingLine(target)));
  };
  const from = window.scrollY;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reduced ? 0 : articleScrollDuration(destination() - from);
  // "instant" overrides the stylesheet's smooth scroll-behavior on <html>.
  if (!duration) {
    window.scrollTo({ top: destination(), behavior: "instant" });
    return;
  }

  let frame = 0;
  let start = 0;
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const onInput = (event: Event) => {
    if (event.type === "keydown" && !SCROLL_KEYS.has((event as KeyboardEvent).key)) return;
    // Pressing another in-page link starts its own jump from wherever this one is.
    if (event.type === "pointerdown" && (event.target as Element | null)?.closest?.('a[href^="#"]')) return;
    stop();
  };
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    inputs.forEach((type) => window.removeEventListener(type, onInput, true));
    if (cancelActive === stop) cancelActive = null;
  }
  function step(now: number) {
    if (!start) start = now;
    const progress = Math.min(1, (now - start) / duration);
    window.scrollTo({ top: from + (destination() - from) * READING_SCROLL_EASE(progress), behavior: "instant" });
    if (progress < 1) frame = requestAnimationFrame(step);
    else stop();
  }
  inputs.forEach((type) => window.addEventListener(type, onInput, { capture: true, passive: true }));
  frame = requestAnimationFrame(step);
  cancelActive = stop;
}
