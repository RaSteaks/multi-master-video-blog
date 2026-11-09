import { describe, expect, it } from "vitest";
import {
  MACHADO,
  TRANSFORMS,
  acesFitted,
  agx,
  agxLogEncode,
  referenceGamutCompress,
  shaperToLinear,
  sourceToAp1,
  stand,
  transformLattice,
  transformVolume,
} from "./color-transform";
import { apply } from "./color-math";

describe("tone mapping transforms", () => {
  it("keeps neutrals neutral and puts 18% grey where each curve does", () => {
    const aces = acesFitted([0.18, 0.18, 0.18]);
    aces.forEach(value => expect(value).toBeCloseTo(0.10559, 4));
    const agxGrey = agx([0.18, 0.18, 0.18]);
    agxGrey.forEach(value => expect(value).toBeCloseTo(0.2146, 2));
    expect(Math.max(...agxGrey) - Math.min(...agxGrey)).toBeLessThan(2e-3);
  });

  it("encodes 18% grey at AgX's log2 midpoint and puts the shaper's grey at 10/16.5", () => {
    expect(agxLogEncode(0.18)).toBeCloseTo(10 / 16.5, 5);
    expect(shaperToLinear(10 / 16.5)).toBeCloseTo(0.18, 10);
  });

  it("rolls bright input off below white instead of clipping it", () => {
    const bright = acesFitted([16, 16, 16]);
    expect(bright[0]).toBeGreaterThan(0.95);
    expect(bright[0]).toBeLessThanOrEqual(1);
  });
});

describe("colour vision deficiency", () => {
  it("keeps white and black, and collapses red and green onto one another for protanopia", () => {
    for (const matrix of Object.values(MACHADO)) {
      apply(matrix, [1, 1, 1]).forEach(value => expect(value).toBeCloseTo(1, 4));
    }
    // A dichromat's matrix is close to rank two: the cube flattens to a sheet.
    const [[a, b, c], [d, e, f], [g, h, i]] = MACHADO.protan;
    expect(Math.abs(a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g))).toBeLessThan(0.02);
  });
});

describe("reference gamut compression", () => {
  it("leaves the protected core alone and pulls far-out colours back toward AP1", () => {
    const core = [0.5, 0.4, 0.3] as const;
    referenceGamutCompress(core).forEach((value, index) => expect(value).toBeCloseTo(core[index], 12));
    const blue = sourceToAp1([0, 0, 1]);
    expect(Math.min(...blue)).toBeLessThan(-0.1);
    const compressed = referenceGamutCompress(blue);
    expect(Math.min(...compressed)).toBeGreaterThan(Math.min(...blue));
    expect(Math.max(...compressed)).toBeCloseTo(Math.max(...blue), 12);
  });
});

describe("transform lattices", () => {
  it("stands the cube on black with white straight above it", () => {
    const black = stand([0, 0, 0]), white = stand([1, 1, 1]);
    expect(white[0]).toBeCloseTo(0, 12);
    expect(white[1]).toBeCloseTo(0, 12);
    expect(black[2]).toBeCloseTo(-white[2], 12);
  });

  it("runs from the input lattice to the output and stays inside the drawing", () => {
    for (const id of TRANSFORMS) {
      const lattice = transformLattice(id);
      for (const amount of [0, 0.5, 1]) {
        const volume = transformVolume(lattice, amount);
        const reach = volume.segments.flatMap(segment => [...segment.from, ...segment.to]).map(Math.abs);
        expect(reach.every(Number.isFinite), `${id} ${amount}`).toBe(true);
        expect(Math.max(...reach), `${id} ${amount}`).toBeLessThan(1.45);
      }
      const start = transformVolume(lattice, 0).segments[0], end = transformVolume(lattice, 1).segments[0];
      start.from.forEach((value, index) => expect(value).toBeCloseTo(stand(lattice.runs[0].from.input)[index], 12));
      end.from.forEach((value, index) => expect(value).toBeCloseTo(stand(lattice.runs[0].from.output)[index], 12));
    }
  });
});
