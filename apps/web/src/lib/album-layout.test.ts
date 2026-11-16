import { describe, expect, it } from "vitest";
import { justifyRows } from "./album-layout";

/** Row heights and photo counts, read back from the widths. */
function rows(ratios: number[], width = 1120, gap = 16, target = 260, max = 360) {
  const placed = justifyRows(ratios, width, gap, target, max);
  const result: { count: number; height: number; used: number; end: number }[] = [];
  let count = 0;
  let used = 0;
  ratios.forEach((ratio, index) => {
    count++;
    used += placed[index * 2] + (count > 1 ? gap : 0);
    if (placed[index * 2 + 1] < 0) return;
    result.push({ count, height: placed[index * 2] / ratio, used, end: placed[index * 2 + 1] });
    count = 0;
    used = 0;
  });
  return result;
}

describe("justifyRows", () => {
  it("fills every row but the last and never exceeds the list width", () => {
    const layout = rows([1.5, 1.5, 2 / 3, 1.5, 2 / 3, 1.5, 1.5]);
    for (const row of layout.slice(0, -1)) {
      expect(row.used + row.end).toBeLessThanOrEqual(1120);
      expect(row.used).toBeGreaterThan(1118);
    }
    const last = layout.at(-1)!;
    expect(last.height).toBeLessThanOrEqual(260);
    expect(last.used + last.end).toBeLessThanOrEqual(1120);
  });

  it("keeps landscape rows nearer the target than greedy wrapping does", () => {
    // Greedy wrapping puts two 3:2 photos per row at 368px; three per row is 240px.
    const layout = rows(Array(9).fill(1.5));
    expect(layout.map(row => row.count)).toEqual([3, 3, 3]);
    for (const row of layout) expect(Math.abs(row.height - 260)).toBeLessThan(30);
  });

  it("gives a lone photo the target height and a panorama the full width", () => {
    expect(rows([1.5])[0].height).toBeCloseTo(260, 0);
    const panorama = rows([6])[0];
    expect(panorama.used).toBeGreaterThan(1118);
    expect(panorama.height).toBeLessThan(260);
  });

  it("returns nothing for an empty album", () => {
    expect(justifyRows([], 1120, 16, 260, 360)).toEqual([]);
  });
});
