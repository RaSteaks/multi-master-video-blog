import { describe, expect, it } from "vitest";
import { READING_EASE, articleScrollDuration, readingHandoff, centeredScrollTop, cubicBezier, currentArticleHeading, retargetEase, tocMotionDuration } from "./article-reading";

describe("current article heading", () => {
  const headings = [
    { id: "first", top: 120 },
    { id: "long-section", top: 400 },
    { id: "last", top: 2400 },
  ];
  const scrolled = (distance: number) => headings.map((heading) => ({ ...heading, top: heading.top - distance }));

  it("starts with the first heading and tolerates an article without headings", () => {
    expect(currentArticleHeading(headings, 92)).toBe("first");
    expect(currentArticleHeading([], 92)).toBeNull();
  });

  it("retains a long section when every heading is outside the viewport", () => {
    expect(currentArticleHeading(scrolled(1500), 92)).toBe("long-section");
  });

  it("reconciles skipped sections and upward jumps from geometry instead of observer delivery order", () => {
    expect(currentArticleHeading(scrolled(2500), 92)).toBe("last");
    expect(currentArticleHeading(scrolled(1500), 92)).toBe("long-section");
    expect(currentArticleHeading(scrolled(0), 92)).toBe("first");
  });

  it("matches anchor offsets and follows a changed reading line after resize", () => {
    expect(currentArticleHeading(scrolled(308), 92)).toBe("long-section");
    expect(currentArticleHeading(scrolled(308), 16)).toBe("first");
    expect(currentArticleHeading(scrolled(384), 16)).toBe("long-section");
  });

  it("recognizes the last section at the article end even when its heading cannot reach the reading line", () => {
    expect(currentArticleHeading(scrolled(1800), 92)).toBe("long-section");
    expect(currentArticleHeading(scrolled(1800), 92, true)).toBe("last");
  });
});

describe("centred TOC scrolling", () => {
  const list = { itemHeight: 30, viewportHeight: 300, scrollHeight: 1200 };

  it("keeps the active item in the middle of a long list", () => {
    expect(centeredScrollTop({ ...list, itemTop: 600 })).toBe(465);
  });

  it("stops at the start and end instead of overscrolling", () => {
    expect(centeredScrollTop({ ...list, itemTop: 40 })).toBe(0);
    expect(centeredScrollTop({ ...list, itemTop: 1150 })).toBe(900);
  });

  it("never scrolls a list that already fits", () => {
    expect(centeredScrollTop({ itemTop: 200, itemHeight: 30, viewportHeight: 300, scrollHeight: 280 })).toBe(0);
  });
});

describe("article jump easing", () => {
  it("matches CSS cubic-bezier reference values", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(linear(0.37)).toBeCloseTo(0.37, 5);
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
  });

  it("eases in briefly, then lands softly, without going backwards", () => {
    const curve = cubicBezier(0.45, 0, 0.15, 1);
    const samples = Array.from({ length: 101 }, (_, i) => curve(i / 100));
    expect(samples.slice(1).every((value, i) => value >= samples[i] - 1e-9)).toBe(true);
    expect(curve(0.1)).toBeLessThan(0.05);
    expect(curve(0.9)).toBeGreaterThan(0.98);
  });

  it("scales duration with distance, within bounds", () => {
    expect(articleScrollDuration(1)).toBe(0);
    expect(articleScrollDuration(100)).toBe(350);
    expect(articleScrollDuration(-2500)).toBe(630);
    expect(articleScrollDuration(80000)).toBe(900);
  });
});

describe("TOC list and indicator motion", () => {
  it("uses brisk durations for short hops and bounded ones for long moves", () => {
    expect(tocMotionDuration(0.5)).toBe(0);
    expect(tocMotionDuration(36)).toBe(256);
    expect(tocMotionDuration(-400)).toBe(340);
    expect(tocMotionDuration(50000)).toBe(600);
  });

  it("starts from rest on the shared reading curve", () => {
    expect(retargetEase(0, 300, 320)).toEqual(READING_EASE);
    expect(retargetEase(-1, 300, 320)).toEqual(READING_EASE);
  });

  it("matches the current speed when retargeting mid-flight", () => {
    const velocity = 1.2;
    const distance = 400;
    const duration = 340;
    const [x1, y1, x2, y2] = retargetEase(velocity, distance, duration);
    const curve = cubicBezier(x1, y1, x2, y2);
    const h = 1e-4;
    const initialSpeed = ((curve(h) - curve(0)) / h) * (distance / duration);
    expect(initialSpeed).toBeCloseTo(velocity, 1);
    expect(curve(0.5)).toBeLessThanOrEqual(1);
  });

  it("changes speed gradually after a retarget, whether it must slow down or speed up", () => {
    for (const [velocity, distance] of [[1.6, 190], [0.6, 300], [2.5, 120]]) {
      const duration = tocMotionDuration(distance);
      const curve = cubicBezier(...retargetEase(velocity, distance, duration));
      const frame = 1000 / 60;
      const speeds = Array.from({ length: 8 }, (_, i) =>
        ((curve(((i + 1) * frame) / duration) - curve((i * frame) / duration)) * distance) / frame);
      for (let i = 1; i < speeds.length; i += 1) {
        expect(speeds[i] / speeds[i - 1]).toBeGreaterThan(0.6);
        expect(speeds[i] / speeds[i - 1]).toBeLessThan(1.6);
      }
    }
  });
});

describe("scroll-linked indicator handoff", () => {
  const crossings = [0, 1000, 1150, 2400];

  it("rests on the current entry for most of a section", () => {
    expect(readingHandoff(crossings, -200, 200)).toEqual({ index: 0, next: 1, progress: 0 });
    expect(readingHandoff(crossings, 500, 200)).toEqual({ index: 0, next: 1, progress: 0 });
  });

  it("slides across the handoff zone in step with scrolling, and arrives as the heading crosses", () => {
    expect(readingHandoff(crossings, 900, 200)?.progress).toBeCloseTo(0.5, 5);
    expect(readingHandoff(crossings, 999.5, 200)).toEqual({ index: 1, next: 2, progress: 0 });
  });

  it("uses the whole section when it is shorter than the zone", () => {
    expect(readingHandoff(crossings, 1075, 200)?.progress).toBeCloseTo(0.5, 5);
  });

  it("stays on the last entry at the end and handles articles without headings", () => {
    expect(readingHandoff(crossings, 2400, 200)).toEqual({ index: 3, next: null, progress: 0 });
    expect(readingHandoff([0, 500, 500], 500, 200)).toEqual({ index: 2, next: null, progress: 0 });
    expect(readingHandoff([], 0, 200)).toBeNull();
  });
});
