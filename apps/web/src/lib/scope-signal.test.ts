import { describe, expect, it } from "vitest";
import { SCOPE_SIGNALS, colorBars, rec709YCbCr, scanLine } from "./scope-signal";

describe("reference signals", () => {
  it("uses Rec.709 chroma scaling", () => {
    const red = rec709YCbCr(1, 0, 0);
    expect(red.luma).toBeCloseTo(0.2126, 4);
    expect(red.cr).toBeCloseTo(0.5, 4);
    expect(red.cb).toBeCloseTo(-0.1146, 4);
  });

  it("orders bars from white to black at the requested level", () => {
    expect(colorBars(0.75).map(bar => bar.label)).toEqual(["W", "YL", "CY", "G", "MG", "R", "B", "K"]);
    expect(colorBars(0.75)[0].luma).toBeCloseTo(0.75, 5);
    expect(colorBars(1)[0].luma).toBeCloseTo(1, 5);
    expect(colorBars(1).at(-1)?.luma).toBe(0);
  });

  it("holds each bar's level across a scan line and ends on black", () => {
    const line = scanLine("bars75", 800);
    expect(line[0].luma).toBeCloseTo(0.75, 5);
    expect(line[150].luma).toBeCloseTo(colorBars(0.75)[1].luma, 5);
    expect(line.at(-1)?.luma).toBe(0);
  });

  it("sweeps the hue circle at full saturation", () => {
    const line = scanLine("hue", 600);
    expect(line[0].rgb).toEqual([1, 0, 0]);
    expect(line[200].rgb).toEqual([0, 1, 0]);
    expect(line[400].rgb).toEqual([0, 0, 1]);
    expect(line.every(({ rgb }) => Math.max(...rgb) === 1 && Math.min(...rgb) === 0)).toBe(true);
  });

  it("reads the 24 ColorChecker patches from the shared presets", () => {
    const line = scanLine("checker", 2400);
    expect(line[0].rgb.map(value => Math.round(value * 255))).toEqual([0x73, 0x52, 0x44]);
    expect(new Set(line.map(({ rgb }) => rgb.join())).size).toBeGreaterThan(24);
  });

  it("keeps every signal inside legal code values", () => {
    for (const signal of SCOPE_SIGNALS) {
      for (const { rgb, cb, cr } of scanLine(signal, 240)) {
        expect(Math.max(...rgb), signal).toBeLessThanOrEqual(1);
        expect(Math.min(...rgb), signal).toBeGreaterThanOrEqual(0);
        expect(Math.abs(cb), signal).toBeLessThanOrEqual(0.5001);
        expect(Math.abs(cr), signal).toBeLessThanOrEqual(0.5001);
      }
    }
  });
});
