import { describe, expect, it } from "vitest";
import { displayRgb, xyToUv1960, xyToUvPrime } from "./color-math";
import { D65_SPD, METAMER_BASE, METAMER_PAIR, TM30_SOURCES } from "./color-science-data";
import { hueLines, isotherms, locus, macadamEllipses, planckianLocus } from "./chromaticity";
import { BIT_DEPTHS, SUBSAMPLING_MODES, bayerChannel, demosaic, lightMix, mosaic, pigmentMix, quantise, reflectanceColor, subsample, testPatch } from "./pixel-demos";
import { daylightXy, insideLocus, planckianXy, spectralLocus, spectrumToXyz } from "./spectral";
import { cameraFit, metamerScene, tm30Frame } from "./spectrum-views";
import {
  FILM,
  TONE_CURVES,
  TRANSFER_CURVES,
  davinciIntermediateEncode,
  filmDensity,
  hlgEncode,
  logC4Encode,
  pqEncode,
  sLog3Encode,
} from "./transfer-curves";

// Reference values from colour-science 0.4.4.
describe("spectral loci", () => {
  it("places the blackbody and the daylight locus where CIE 015 does", () => {
    for (const [kelvin, x, y] of [[2000, 0.5266768, 0.4132994], [2856, 0.4475366, 0.4074303], [6504, 0.3134646, 0.3235692], [10000, 0.2806341, 0.2882889]]) {
      const [actualX, actualY] = planckianXy(kelvin);
      expect(actualX, `${kelvin} K`).toBeCloseTo(x, 3);
      expect(actualY, `${kelvin} K`).toBeCloseTo(y, 3);
    }
    const [x, y] = daylightXy(6504 * 1.4388 / 1.438);
    expect(x).toBeCloseTo(0.3126555, 4);
    expect(y).toBeCloseTo(0.3290609, 4);
  });

  it("traces the spectral locus and knows what lies inside it", () => {
    const green = spectralLocus().find(({ wavelength }) => wavelength === 520)!;
    expect(green.xy[0]).toBeCloseTo(0.0743024, 4);
    expect(green.xy[1]).toBeCloseTo(0.8338031, 4);
    expect(insideLocus(0.3127, 0.329)).toBe(true);
    expect(insideLocus(0.05, 0.05)).toBe(false);
    expect(insideLocus(0.7, 0.6)).toBe(false);
  });

  it("draws isotherms across the Planckian locus and ellipses rounder in u′v′", () => {
    expect(locus().length).toBeGreaterThan(60);
    expect(planckianLocus().every(([x, y]) => insideLocus(x, y))).toBe(true);
    // Isotherms are straight and centred in CIE 1960 uv, where CCT is defined.
    for (const { kelvin, ends } of isotherms()) {
      const [u, v] = xyToUv1960(...planckianXy(kelvin));
      const [start, end] = ends.map(([x, y]) => xyToUv1960(x, y));
      expect((start[0] + end[0]) / 2, `${kelvin}`).toBeCloseTo(u, 6);
      expect((start[1] + end[1]) / 2, `${kelvin}`).toBeCloseTo(v, 6);
    }
    const ellipses = macadamEllipses();
    expect(ellipses.length).toBe(25);
    // Elongation (longest / shortest diameter), averaged: u′v′ was built to even it out.
    const elongation = (points: readonly (readonly [number, number])[], [cx, cy]: readonly [number, number]) => {
      const radii = points.map(([x, y]) => Math.hypot(x - cx, y - cy));
      return Math.max(...radii) / Math.min(...radii);
    };
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const xy = mean(ellipses.map(ellipse => elongation(ellipse.xy, ellipse.center)));
    const uv = mean(ellipses.map(ellipse => elongation(ellipse.uv, xyToUvPrime(...ellipse.center))));
    expect(uv).toBeLessThan(xy);
  });

  it("starts each hue line at the neutral and keeps it inside the locus", () => {
    for (const line of hueLines()) {
      for (const path of [line.lab, line.ok]) {
        expect(path.length, `${line.degrees}°`).toBeGreaterThan(5);
        expect(path[0][0]).toBeCloseTo(0.3127, 3);
        expect(path.every(([x, y]) => insideLocus(x, y))).toBe(true);
      }
    }
  });
});

describe("transfer functions", () => {
  it("matches each camera log curve at 18% grey", () => {
    expect(logC4Encode(0.18)).toBeCloseTo(0.278395836548, 8);
    expect(logC4Encode(0)).toBeCloseTo(0.0928641251222, 8);
    expect(logC4Encode(-0.01)).toBeCloseTo(0.0527780170733, 8);
    expect(sLog3Encode(0.18)).toBeCloseTo(420 / 1023, 8);
    expect(davinciIntermediateEncode(0.18)).toBeCloseTo(0.336043272385, 8);
  });

  it("puts HDR reference white at BT.2408's signal levels", () => {
    expect(pqEncode(203)).toBeCloseTo(0.580688881042, 8);
    expect(hlgEncode(0.26496)).toBeCloseTo(0.75, 4);
    for (const curve of TRANSFER_CURVES) {
      const values = Array.from({ length: 64 }, (_, index) => curve.encode(0.18 * 2 ** (index / 4 - 8)));
      expect(values.every(Number.isFinite), curve.label).toBe(true);
      expect(values.every((value, index) => index === 0 || value >= values[index - 1] - 1e-12), curve.label).toBe(true);
    }
  });

  it("keeps every tone curve rising and inside the display", () => {
    for (const curve of TONE_CURVES) {
      const values = Array.from({ length: 64 }, (_, index) => curve.encode(0.18 * 2 ** (index / 4 - 8)));
      expect(values.every(value => value >= 0 && value <= 1.0001), curve.label).toBe(true);
      expect(values.every((value, index) => index === 0 || value >= values[index - 1] - 1e-9), curve.label).toBe(true);
    }
  });

  it("draws the schematic film curve from base + fog up a straight line of slope γ", () => {
    expect(filmDensity(FILM.range[0])).toBeCloseTo(FILM.baseFog, 2);
    // Near a grey card the shoulder has only begun to bend the line.
    const slope = (filmDensity(0.1) - filmDensity(-0.1)) / 0.2;
    expect(slope).toBeCloseTo(FILM.gamma, 1);
    expect(filmDensity(FILM.range[1])).toBeCloseTo(FILM.baseFog + FILM.gamma * (FILM.shoulder - FILM.toe), 1);
  });
});

describe("spectrum views", () => {
  it("preserves the swatch colours when adapting D65 to itself", () => {
    const scene = metamerScene(0);
    for (const [index, reflectance] of [METAMER_BASE, METAMER_PAIR].entries()) {
      const expected = displayRgb(spectrumToXyz(reflectance, D65_SPD));
      expected.forEach((value, channel) => expect(scene.colors[index][channel]).toBeCloseTo(value, 12));
    }
  });

  it("matches the metamers under D65 and parts them under illuminant A", () => {
    expect(metamerScene(0).deltaE).toBeLessThan(0.01);
    expect(metamerScene(1).deltaE).toBeGreaterThan(10);
  });

  it("fits a camera that misses the Luther condition, but not by much", () => {
    expect(cameraFit.camera.every(channel => Math.max(...channel) === 1)).toBe(true);
    for (const residual of cameraFit.residual) {
      expect(residual).toBeGreaterThan(0.01);
      expect(residual).toBeLessThan(0.6);
    }
  });

  it("keeps each TM-30 graphic paired with the measurements for its own illuminant", () => {
    expect(tm30Frame(0).rf).toBe(100);
    TM30_SOURCES.forEach((source, index) => {
      const frame = tm30Frame(index);
      expect(frame).toMatchObject({ label: source.label, cct: source.cct, rf: source.rf, rg: source.rg, reference: source.reference });
      expect(frame.test.flat()).toEqual(source.test);
    });
  });
});

describe("pixel demos", () => {
  it.each(SUBSAMPLING_MODES)("keeps luma and displayable RGB at every pixel of the %s example", mode => {
    const patch = testPatch();
    const { image, chromaSamples } = subsample(patch, mode);
    expect(chromaSamples.length).toBe({ "4:4:4": 16 * 12, "4:2:2": 8 * 12, "4:2:0": 8 * 6 }[mode]);
    const luma = ([r, g, b]: readonly number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    patch.forEach((row, y) => row.forEach((pixel, x) => {
      const rebuilt = image[y][x];
      expect(rebuilt.every(channel => channel >= 0 && channel <= 1), `pixel ${x},${y}`).toBe(true);
      expect(luma(rebuilt)).toBeCloseTo(luma(pixel), 10);
    }));
  });

  it("quantises to the stated number of levels", () => {
    expect(BIT_DEPTHS).toEqual([6, 8, 10, 12]);
    expect(quantise(0.5, 8)).toBeCloseTo(128 / 255, 10);
    expect(new Set(Array.from({ length: 1000 }, (_, index) => quantise(index / 999 * 0.08, 8))).size).toBe(21);
  });

  it("reads one channel per photosite in an RGGB pattern and rebuilds flat colour exactly", () => {
    expect([bayerChannel(0, 0), bayerChannel(1, 0), bayerChannel(0, 1), bayerChannel(1, 1)]).toEqual([0, 1, 1, 2]);
    const flat = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => [0.4, 0.6, 0.2] as const));
    demosaic(mosaic(flat)).forEach(row => row.forEach(pixel => pixel.forEach((value, channel) =>
      expect(value).toBeCloseTo(flat[0][0][channel], 10))));
  });

  it("mixes blue and yellow paint into green but blue and yellow light into a grey", () => {
    const [r, g, b] = reflectanceColor(pigmentMix(0.5));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    const light = lightMix(0.5);
    expect(Math.max(...light) - Math.min(...light)).toBeLessThan(g - Math.min(r, b));
  });
});
