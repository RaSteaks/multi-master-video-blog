import { describe, expect, it } from "vitest";
import {
  ACCENT_SURFACE_HEX,
  COLOR_CHECKER_PRESETS,
  DEFAULT_ACCENT_HEX,
  MIN_TEXT_CONTRAST,
  chooseOnAccent,
  contrastRatio,
  createStoredTheme,
  deriveReadableColor,
  hexToHsv,
  hsvToHex,
  parseStoredTheme,
  resolveThemeColor,
  srgbHexToRec709Hex,
} from "./theme-color";

const EXPECTED_COLOR_CHECKER_HEX = [
  "#735244",
  "#C29682",
  "#627A9D",
  "#576C43",
  "#8580B1",
  "#67BDAA",
  "#D67E2C",
  "#505BA6",
  "#C15A63",
  "#5E3C6C",
  "#9DBC40",
  "#E0A32E",
  "#383D96",
  "#469449",
  "#AF363C",
  "#E7C71F",
  "#BB5695",
  "#0885A1",
  "#F3F3F3",
  "#C8C8C8",
  "#A0A0A0",
  "#7A7A7A",
  "#555555",
  "#343434",
];

describe("ColorChecker presets", () => {
  it("pins all 24 IDs and sRGB values in chart order", () => {
    expect(COLOR_CHECKER_PRESETS).toHaveLength(24);
    expect(COLOR_CHECKER_PRESETS.map((preset) => preset.id)).toEqual(
      Array.from(
        { length: 24 },
        (_, index) => `cc${String(index + 1).padStart(2, "0")}`
      )
    );
    expect(COLOR_CHECKER_PRESETS.map((preset) => preset.hex)).toEqual(
      EXPECTED_COLOR_CHECKER_HEX
    );
  });
});

describe("HSV conversion", () => {
  it.each(["#FF0000", "#00FF00", "#0000FF", "#7A7A7A", "#67BDAA"])(
    "round-trips %s through HSV",
    (hex) => {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  );

  it("clamps custom HSV to the documented integer range", () => {
    const stored = createStoredTheme({
      kind: "custom",
      hsv: { h: 400.4, s: -2, v: 120 },
    });
    expect(stored.hsv).toEqual({ h: 359, s: 0, v: 100 });
    expect(stored.base).toBe("#FFFFFF");
  });
});

describe("sRGB and Rec.709 encoding preview", () => {
  it.each([
    ["#000000", "#000000"],
    ["#FFFFFF", "#FFFFFF"],
    ["#FF0000", "#FF0000"],
    ["#808080", "#737373"],
    ["#7A7A7A", "#6D6D6D"],
  ])("maps sRGB %s to Rec.709 code value %s", (srgb, rec709) => {
    expect(srgbHexToRec709Hex(srgb)).toBe(rec709);
  });
});

describe("accessible accent derivation", () => {
  it("uses ColorChecker Neutral 5 as the default", () => {
    const resolved = resolveThemeColor(null);
    expect(resolved.base).toBe(DEFAULT_ACCENT_HEX);
    expect(resolved.readable).toBe("#929292");
    expect(resolved.contrast).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it.each(COLOR_CHECKER_PRESETS)(
    "derives readable text for $id $hex",
    ({ hex }) => {
      const readable = deriveReadableColor(hex);
      expect(
        contrastRatio(readable.color, ACCENT_SURFACE_HEX)
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  );

  it.each(["#000000", "#383D96", "#7A7A7A", "#E7C71F", "#FFFFFF"])(
    "chooses the higher-contrast on-accent color for %s",
    (hex) => {
      const selected = chooseOnAccent(hex);
      const alternative = selected === "#0C0E10" ? "#F3F3F3" : "#0C0E10";
      expect(contrastRatio(selected, hex)).toBeGreaterThanOrEqual(
        contrastRatio(alternative, hex)
      );
    }
  );
});

describe("local storage schema", () => {
  it("recomputes cached colors instead of trusting persisted values", () => {
    const parsed = parseStoredTheme(
      JSON.stringify({
        version: 1,
        kind: "preset",
        presetId: "cc22",
        base: "#FFFFFF",
        readable: "#FFFFFF",
        onAccent: "#FFFFFF",
      })
    );
    expect(parsed?.base).toBe("#7A7A7A");
    expect(parsed?.readable).toBe("#929292");
  });

  it.each([
    null,
    "",
    "{}",
    '{"version":2,"kind":"preset","presetId":"cc22"}',
    '{"version":1,"kind":"preset","presetId":"cc25"}',
    '{"version":1,"kind":"custom","hsv":{"h":360,"s":50,"v":50}}',
    "not-json",
  ])("rejects invalid payload %s", (payload) => {
    expect(parseStoredTheme(payload)).toBeNull();
  });
});
