import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { hsvToHex } from "./theme-color";
import {
  LIQUID_BOOTSTRAP_SCRIPT,
  LIQUID_STORAGE_KEY,
  defaultLiquidPreferences,
  liquidPaletteFromSettings,
  resetLiquidPreferences,
  resolveLiquidPreferences,
  saveLiquidSlot,
  type LiquidPreferences,
} from "./liquid-preferences";

function resolve(input: Partial<LiquidPreferences>) {
  return resolveLiquidPreferences(JSON.stringify({ version: 1, ...input }));
}

describe("liquid preferences", () => {
  it.each([
    null,
    "invalid",
    "null",
    "[]",
    '{"version":2}',
    '{"version":1,"color":{"kind":"custom","hsv":{}}}',
  ])("recovers malformed preferences: %s", (raw) => {
    expect(resolveLiquidPreferences(raw).settings).toEqual(
      defaultLiquidPreferences(),
    );
  });
  it("preserves the exact original gray palette and durations", () => {
    expect(resolveLiquidPreferences(null).css).toEqual({
      "--liquid-base": "#121518",
      "--liquid-blob-1": "130 134 138",
      "--liquid-blob-2": "108 112 116",
      "--liquid-blob-3": "118 122 126",
      "--liquid-duration-1": "20s",
      "--liquid-duration-2": "23s",
      "--liquid-duration-3": "22s",
      "--liquid-play-state": "running",
    });
  });
  it("derives the normalized WebGL palette from the existing CSS palette", () => {
    expect(liquidPaletteFromSettings(defaultLiquidPreferences())).toEqual([
      [130 / 255, 134 / 255, 138 / 255],
      [108 / 255, 112 / 255, 116 / 255],
      [118 / 255, 122 / 255, 126 / 255],
    ]);
  });
  it.each([
    [-1, 0],
    [0, 0],
    [0.14, 0.1],
    [1, 1],
    [2.99, 3],
    [9, 3],
    [NaN, 1],
    [Infinity, 1],
  ])("normalizes speed %s to %s", (input, expected) => {
    const result = resolve({ speed: input });
    expect(result.settings.speed).toBe(expected);
    expect(result.css["--liquid-play-state"]).toBe(
      expected === 0 ? "paused" : "running",
    );
    expect(Object.values(result.css).join(" ")).not.toMatch(/Infinity|NaN/);
  });
  it("scales all three periods together", () => {
    expect(resolve({ speed: 2 }).css).toMatchObject({
      "--liquid-duration-1": "10s",
      "--liquid-duration-2": "11.5s",
      "--liquid-duration-3": "11s",
    });
  });
  it("matches the existing HSV converter across hues, saturation and brightness", () => {
    for (let h = 0; h < 360; h += 17)
      for (const s of [0, 30, 100])
        for (const v of [0, 8, 50, 100]) {
          const hsv = { h, s, v };
          expect(
            resolve({ color: { kind: "custom", hsv } }).css["--liquid-base"],
          ).toBe("#121518");
          expect(resolve({ color: { kind: "custom", hsv } }).swatchHex).toBe(
            hsvToHex(hsv),
          );
        }
    expect(
      resolve({ color: { kind: "custom", hsv: { h: 0, s: 100, v: 100 } } }).css,
    ).toMatchObject({
      "--liquid-base": "#121518",
      "--liquid-blob-1": "255 89 89",
      "--liquid-blob-2": "255 77 77",
      "--liquid-blob-3": "255 82 82",
    });
  });
  it("normalizes HSV and repairs individual slots without discarding good preferences", () => {
    const result = resolveLiquidPreferences(
      JSON.stringify({
        version: 1,
        speed: 2,
        color: { kind: "custom", hsv: { h: 500, s: -4, v: 99.9 } },
        slots: [{ kind: "gray" }, { kind: "oops" }],
      }),
    );
    expect(result.settings.color).toEqual({
      kind: "custom",
      hsv: { h: 359, s: 0, v: 100 },
    });
    expect(result.settings.slots).toEqual([
      { kind: "gray" },
      null,
      null,
      null,
      null,
    ]);
    expect(result.settings.speed).toBe(2);
  });
  it("saves, overwrites and clears exactly five slots without changing the applied color", () => {
    const initial = defaultLiquidPreferences();
    const saved = saveLiquidSlot(initial, 4);
    expect(saved.slots[4]).toEqual({ kind: "gray" });
    expect(initial.slots[4]).toBeNull();
    const custom = { kind: "custom" as const, hsv: { h: 180, s: 60, v: 50 } };
    const overwritten = saveLiquidSlot(saved, 4, custom);
    expect(overwritten.slots[4]).toEqual(custom);
    expect(overwritten.color).toEqual(initial.color);
    expect(saveLiquidSlot(overwritten, 4, null).slots).toEqual(
      Array(5).fill(null),
    );
    expect(saveLiquidSlot(overwritten, 5)).toBe(overwritten);
    expect(saveLiquidSlot(overwritten, -1)).toBe(overwritten);
    expect(
      resetLiquidPreferences({ ...overwritten, speed: 0, color: custom }),
    ).toEqual({ ...initial, slots: overwritten.slots });
  });
  it("restores the same palette before hydration as after hydration", () => {
    const preferences = {
      ...defaultLiquidPreferences(),
      speed: 2.3,
      color: { kind: "custom" as const, hsv: { h: 218, s: 71, v: 32 } },
    };
    const raw = JSON.stringify(preferences);
    const applied: Record<string, string> = {};
    runInNewContext(LIQUID_BOOTSTRAP_SCRIPT, {
      localStorage: {
        getItem: (key: string) => {
          expect(key).toBe(LIQUID_STORAGE_KEY);
          return raw;
        },
      },
      document: {
        documentElement: {
          style: {
            setProperty: (key: string, value: string) => {
              applied[key] = value;
            },
          },
        },
      },
    });
    expect(applied).toEqual(resolveLiquidPreferences(raw).css);
    expect(applied["--liquid-base"]).toBe("#121518");
  });
  it("allows startup when storage is blocked", () => {
    expect(() =>
      runInNewContext(LIQUID_BOOTSTRAP_SCRIPT, {
        localStorage: {
          getItem: () => {
            throw new Error("blocked");
          },
        },
      }),
    ).not.toThrow();
  });
});
