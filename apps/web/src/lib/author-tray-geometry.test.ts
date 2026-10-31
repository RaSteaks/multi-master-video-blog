import { describe, expect, it } from "vitest";
import { AUTHOR_TRAY_INNER_RATIO, authorTrayBlades, authorTrayLayout, pointInPolygon } from "./author-tray-geometry";

describe("cursor-centered author tray placement", () => {
  it("keeps the exact cursor point as the center when there is room", () => {
    expect(authorTrayLayout({ x: 500, y: 350 }, 1280, 900)).toEqual({ x: 500, y: 350, radius: 176 });
    expect(authorTrayLayout({ x: 500.5, y: 350.25 }, 1280, 900)).toEqual({ x: 500.5, y: 350.25, radius: 176 });
  });
  it("reduces radius in narrow windows without moving the cursor's center", () => {
    expect(authorTrayLayout({ x: 186, y: 350 }, 372, 700)).toEqual({ x: 186, y: 350, radius: 174 });
  });
  it("waits at every edge rather than clipping or recentering the disk", () => {
    for (const point of [{ x: 30, y: 350 }, { x: 1250, y: 350 }, { x: 500, y: 20 }, { x: 500, y: 880 }]) {
      expect(authorTrayLayout(point, 1280, 900)).toBeNull();
    }
  });
  it("respects the minimum readable radius and the edge margin", () => {
    expect(authorTrayLayout({ x: 182, y: 350 }, 1280, 900)).toEqual({ x: 182, y: 350, radius: 170 });
    expect(authorTrayLayout({ x: 181, y: 350 }, 1280, 900)).toBeNull();
    expect(authorTrayLayout({ x: 170, y: 170 }, 340, 340)).toBeNull();
  });
});

describe("author tray iris blades", () => {
  // Blade counts vary: film import is development-only, albums add an action.
  const counts = [4, 5, 6, 7];
  const between = (from: [number, number], to: [number, number], t: number): [number, number] =>
    [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];

  it("keeps the first action at twelve o'clock", () => {
    for (const count of counts) {
      const [first] = authorTrayBlades(count).blades;
      expect(first.labelX).toBeCloseTo(50, 0);
      expect(first.labelY).toBeLessThan(50);
    }
  });
  it("centers each label on its own blade", () => {
    for (const count of counts) {
      for (const blade of authorTrayBlades(count).blades) expect(pointInPolygon([blade.labelX, blade.labelY], blade.outline)).toBe(true);
    }
  });
  it("selects the same blade along a straight flick from the opening to its label", () => {
    for (const count of counts) {
      for (const blade of authorTrayBlades(count).blades) {
        const label: [number, number] = [blade.labelX, blade.labelY];
        const distance = Math.hypot(label[0] - 50, label[1] - 50);
        const start = (50 * AUTHOR_TRAY_INNER_RATIO + 1.5) / distance;
        for (let t = start; t <= 1; t += 0.05) expect(pointInPolygon(between([50, 50], label, t), blade.outline)).toBe(true);
      }
    }
  });
  it("keeps the widest label box inside its blade at the smallest disk", () => {
    // Text does not scale with the disk: a 50×57px icon and two lines.
    const halfWidth = 25 / 3.4, halfHeight = 28.5 / 3.4; // Percent of a 340px disk.
    for (const count of counts) {
      for (const { labelX, labelY, outline } of authorTrayBlades(count).blades) {
        for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
          expect(pointInPolygon([labelX + x * halfWidth, labelY + y * halfHeight], outline)).toBe(true);
        }
      }
    }
  });
  it("leaves the opening free so its center can cancel", () => {
    for (const count of counts) {
      for (const { outline } of authorTrayBlades(count).blades) expect(pointInPolygon([50, 50], outline)).toBe(false);
    }
  });
});
