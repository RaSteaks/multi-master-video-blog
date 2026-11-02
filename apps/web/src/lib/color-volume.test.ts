import { describe, expect, it } from "vitest";
import { COLOR_MODELS, GAMUTS, colorVolume, modelCoordinates } from "./color-volume";

describe("colour models", () => {
  it("places white on the neutral axis in the appearance models", () => {
    for (const gamut of GAMUTS) {
      for (const model of COLOR_MODELS.filter(model => model !== "xyz" && model !== "xyy")) {
        const [, a, b] = modelCoordinates(gamut, model, [1, 1, 1]);
        expect(Math.hypot(a, b), `${gamut} ${model}`).toBeLessThan(0.05);
      }
    }
  });

  it("gives XYZ as measured, including AP0's own D60 white", () => {
    expect(modelCoordinates("rec709", "xyz", [1, 1, 1])[1]).toBeCloseTo(1, 5);
    const [x, y, z] = modelCoordinates("ap0", "xyz", [1, 1, 1]);
    expect(x / (x + y + z)).toBeCloseTo(0.32168, 4);
    expect(y / (x + y + z)).toBeCloseTo(0.33767, 4);
    expect(modelCoordinates("ap0", "xyz", [0, 0, 1])[1]).toBeLessThan(0);
  });

  it("matches published sRGB red in CIELAB and Oklab", () => {
    const lab = modelCoordinates("rec709", "cielab", [1, 0, 0]);
    expect(lab[0]).toBeCloseTo(53.24, 1);
    expect(lab[1]).toBeCloseTo(80.09, 0);
    expect(lab[2]).toBeCloseTo(67.2, 0);
    const oklab = modelCoordinates("rec709", "oklab", [1, 0, 0]);
    expect(oklab[0]).toBeCloseTo(0.628, 2);
    expect(oklab[1]).toBeCloseTo(0.225, 2);
    expect(oklab[2]).toBeCloseTo(0.126, 2);
  });

  // ITU-R BT.2020-2 Table 3 primaries/D65, with peak white Y=1.
  it.each([
    { rgb: [1, 0, 0], expected: [0.708, 0.292, 0.2627002] },
    { rgb: [0, 1, 0], expected: [0.170, 0.797, 0.6779981] },
    { rgb: [0, 0, 1], expected: [0.131, 0.046, 0.0593017] },
    { rgb: [1, 1, 1], expected: [0.3127, 0.3290, 1] },
  ] as const)("gives BT.2020 xyY coordinates for $rgb", ({ rgb, expected }) => {
    const actual = modelCoordinates("rec2020", "xyy", rgb);
    expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 6));
  });

  it("changes luminance without moving chromaticity when a colour dims", () => {
    for (const gamut of GAMUTS) {
      const bright = modelCoordinates(gamut, "xyy", [1, 0.5, 0.25]);
      const dim = modelCoordinates(gamut, "xyy", [0.1, 0.05, 0.025]);
      expect(dim[0]).toBeCloseTo(bright[0], 12);
      expect(dim[1]).toBeCloseTo(bright[1], 12);
      expect(dim[2]).toBeCloseTo(bright[2] / 10, 12);
    }
  });

  it("keeps AP0's D60 white and imaginary blue in xyY", () => {
    const white = modelCoordinates("ap0", "xyy", [1, 1, 1]);
    expect(white[0]).toBeCloseTo(0.32168, 6);
    expect(white[1]).toBeCloseTo(0.33767, 6);
    expect(white[2]).toBeCloseTo(1, 6);
    const blue = modelCoordinates("ap0", "xyy", [0, 0, 1]);
    expect(blue[0]).toBeCloseTo(0.0001, 6);
    expect(blue[1]).toBeCloseTo(-0.077, 6);
    expect(blue[2]).toBeLessThan(0);
  });

  it("leaves black chromaticity undefined in xyY", () => {
    const [x, y, luminance] = modelCoordinates("rec2020", "xyy", [0, 0, 0]);
    expect(x).toBeNaN();
    expect(y).toBeNaN();
    expect(luminance).toBe(0);
  });

  it("maps black to zero in XYZ and the appearance models", () => {
    for (const model of COLOR_MODELS.filter(model => model !== "xyy")) {
      expect(modelCoordinates("rec2020", model, [0, 0, 0])[0], model).toBeCloseTo(0, 5);
    }
  });
});

describe("colorVolume", () => {
  it("stays finite and inside the drawing for every gamut and model", () => {
    for (const gamut of GAMUTS) {
      for (const model of COLOR_MODELS) {
        const limit = colorVolume(gamut, model).segments.flatMap(segment => [...segment.from, ...segment.to]).map(Math.abs);
        expect(limit.every(Number.isFinite), `${gamut} ${model}`).toBe(true);
        expect(Math.max(...limit), `${gamut} ${model}`).toBeLessThan(1.45);
      }
    }
  });

  it("draws a wider display gamut with more chroma", () => {
    const reach = (gamut: "rec709" | "rec2020") =>
      Math.max(...colorVolume(gamut, "cielab").segments.map(({ from }) => Math.hypot(from[0], from[1])));
    expect(reach("rec2020")).toBeCloseTo(1, 5);
    expect(reach("rec709")).toBeLessThan(reach("rec2020"));
  });

  it("labels the axes of the chosen coordinates", () => {
    expect(colorVolume("rec709", "xyz").axes.map(axis => axis.label)).toEqual(["X", "Y", "Z"]);
    expect(colorVolume("rec709", "xyz").axes[1].ticks.map(tick => tick.label)).toEqual(["0.5", "1.0"]);
    expect(colorVolume("rec709", "cielab").axes.map(axis => axis.label)).toEqual(["L*", "a*", "b*"]);
    const axes = colorVolume("rec2020", "xyy").axes;
    expect(axes.map(axis => axis.label)).toEqual(["x", "y", "Y"]);
    expect(axes[2].ticks.map(tick => tick.label)).toEqual(["0.5", "1.0"]);
    expect(axes[2].to[0]).toBe(axes[2].from[0]);
    expect(axes[2].to[1]).toBe(axes[2].from[1]);
    expect(axes[2].to[2]).toBeGreaterThan(axes[2].from[2]);
  });

  it("approaches black along each primary's own xy instead of joining them", () => {
    for (const gamut of GAMUTS) {
      const volume = colorVolume(gamut, "xyy");
      const darkEnds = volume.segments.filter(segment => segment.color.every(value => value === 0));
      expect(darkEnds.length).toBeGreaterThan(0);
      for (const segment of darkEnds) {
        expect(segment.from[0]).toBeCloseTo(segment.to[0], 12);
        expect(segment.from[1]).toBeCloseTo(segment.to[1], 12);
        expect(segment.from[2]).toBe(volume.axes[2].from[2]);
      }
      expect(new Set(darkEnds.map(segment => segment.from.slice(0, 2).join(","))).size).toBe(3);
    }
  });
});
