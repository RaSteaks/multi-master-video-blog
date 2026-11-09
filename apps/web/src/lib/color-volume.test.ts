import { describe, expect, it } from "vitest";
import { COLOR_MODELS, GAMUTS, VOLUME_OVERLAYS, colorVolume, gamutPrimaries, modelCoordinates } from "./color-volume";
import { WAVELENGTHS, optimalColor } from "./spectral";

describe("colour models", () => {
  it("places white on the neutral axis in the appearance models", () => {
    for (const gamut of GAMUTS) {
      for (const model of COLOR_MODELS.filter(model => !["xyz", "xyy", "lms"].includes(model))) {
        const [, a, b] = modelCoordinates(gamut, model, [1, 1, 1]);
        // ZCAM leaves D65 white faintly colourful (colour-science gives Mz ≈ 0.42 of red's 52.6).
        expect(Math.hypot(a, b), `${gamut} ${model}`).toBeLessThan(model === "zcam" ? 0.5 : 0.05);
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

  // Reference values from colour-science 0.4.4 for linear sRGB red.
  it.each([
    { model: "cieluv", expected: [53.2371156, 175.0098222, 37.7650936], digits: 1 },
    { model: "ipt", expected: [0.4561614, 0.6209296, 0.4428087], digits: 3 },
    { model: "jzazbz", expected: [0.1343847, 0.1178853, 0.1118781], digits: 4 },
  ] as const)("matches colour-science for sRGB red in $model", ({ model, expected, digits }) => {
    const actual = modelCoordinates("rec709", model, [1, 0, 0]);
    expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
  });

  it("matches colour-science ZCAM lightness, colourfulness and hue for sRGB red", () => {
    const [lightness, a, b] = modelCoordinates("rec709", "zcam", [1, 0, 0]);
    expect(lightness).toBeCloseTo(51.197, 1);
    expect(Math.hypot(a, b)).toBeCloseTo(52.599, 1);
    expect(Math.atan2(b, a) * 180 / Math.PI).toBeCloseTo(42.477, 1);
    expect(modelCoordinates("rec709", "zcam", [1, 1, 1])[0]).toBeCloseTo(100, 6);
  });

  it("puts the RGB-derived models on Rec.709 R′G′B′", () => {
    const [luma, cb, cr] = modelCoordinates("rec709", "ycbcr", [1, 0, 0]);
    expect(luma).toBeCloseTo(0.2126, 4);
    expect(cb).toBeCloseTo(-0.2126 / 1.8556, 4);
    expect(cr).toBeCloseTo(0.5, 4);
    expect(modelCoordinates("rec709", "hsv", [1, 0, 0])[0]).toBeCloseTo(1, 6);
    expect(modelCoordinates("rec709", "hsl", [1, 0, 0])[0]).toBeCloseTo(0.5, 6);
    // Rec.2020 green lies outside Rec.709, so its red channel goes negative.
    expect(modelCoordinates("rec2020", "hsv", [0, 1, 0])[0]).toBeGreaterThan(1);
  });

  it("normalises LMS so D65 white is one in every cone", () => {
    modelCoordinates("rec709", "lms", [1, 1, 1]).forEach(value => expect(value).toBeCloseTo(1, 6));
  });

  it("matches the published primaries of the camera and ACES working gamuts", () => {
    const xy = (gamut: (typeof GAMUTS)[number]) => gamutPrimaries(gamut).flat();
    [0.713, 0.293, 0.165, 0.83, 0.128, 0.044].forEach((value, index) => expect(xy("ap1")[index]).toBeCloseTo(value, 4));
    [0.8, 0.313, 0.1682, 0.9877, 0.079, -0.1155].forEach((value, index) => expect(xy("dwg")[index]).toBeCloseTo(value, 4));
    [0.7347, 0.2653, 0.1424, 0.8576, 0.0991, -0.0308].forEach((value, index) => expect(xy("awg4")[index]).toBeCloseTo(value, 4));
    [0.73, 0.28, 0.14, 0.855, 0.1, -0.05].forEach((value, index) => expect(xy("sgamut3")[index]).toBeCloseTo(value, 4));
  });
});

describe("colorVolume", () => {
  it("stays finite and inside the drawing for every gamut, model and overlay", () => {
    for (const gamut of GAMUTS) {
      for (const model of COLOR_MODELS) {
        for (const overlay of VOLUME_OVERLAYS) {
          const volume = colorVolume(gamut, model, overlay);
          const limit = [...volume.segments, ...(volume.overlay ?? [])].flatMap(segment => [...segment.from, ...segment.to]).map(Math.abs);
          expect(limit.every(Number.isFinite), `${gamut} ${model} ${overlay}`).toBe(true);
          expect(Math.max(...limit), `${gamut} ${model} ${overlay}`).toBeLessThan(1.45);
          expect((volume.overlay?.length ?? 0) > 0, `${gamut} ${model} ${overlay}`).toBe(overlay !== "none");
        }
      }
    }
  });

  it("closes the optimal colours at the D65 white and puts sRGB inside them", () => {
    const [x, y, z] = optimalColor(0, WAVELENGTHS.length);
    expect(x).toBeCloseTo(0.9505, 3);
    expect(y).toBeCloseTo(1, 6);
    expect(z).toBeCloseTo(1.089, 2);
    const reach = (segments: { from: readonly number[] }[]) => Math.max(...segments.map(({ from }) => Math.hypot(from[0], from[1])));
    const volume = colorVolume("rec709", "cielab", "optimal");
    expect(reach(volume.overlay!)).toBeGreaterThan(reach(volume.segments));
  });

  it("labels the three gradient paths and bends the encoded one through darker greys", () => {
    const volume = colorVolume("rec709", "oklab", "gradient");
    expect(volume.marks?.map(mark => mark.label)).toEqual(["sRGB", "线性", "Oklab"]);
    const [encoded, light] = volume.marks!;
    expect(encoded.at[2]).toBeLessThan(light.at[2]);
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
