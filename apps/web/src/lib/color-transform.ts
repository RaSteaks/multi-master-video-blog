/** Colour transforms shown as a 3D LUT does them: a lattice of inputs moved to its outputs. */

import {
  apply,
  clamp01,
  invert,
  lerpVector,
  mapVector,
  multiply,
  srgbDecode,
  srgbEncode,
  type Matrix,
  type Vector,
} from "./color-math";
import { cubeLines, cubeRuns, gamutToRec709, type ColorVolume, type GamutId, type VolumeMark, type WireSegment } from "./color-volume";

export const TRANSFORMS = ["aces", "agx", "protan", "deutan", "tritan", "rgc"] as const;
export type TransformId = (typeof TRANSFORMS)[number];

export const TRANSFORM_LABELS: Record<TransformId, string> = {
  aces: "3D LUT · ACES 色调映射（Hill 拟合）",
  agx: "3D LUT · AgX（Filament 实现）",
  protan: "色觉模拟 · 红色盲（Machado 2009）",
  deutan: "色觉模拟 · 绿色盲（Machado 2009）",
  tritan: "色觉模拟 · 蓝色盲（Machado 2009）",
  rgc: "色域压缩 · DaVinci WG → AP1（ACES RGC）",
};

// Tone mappers read the lattice through a log2 shaper, -10 to +6.5 stops about 18% grey, as a LUT for scene-linear input does.
const SHAPER_MIN = -10, SHAPER_MAX = 6.5, MIDDLE_GREY = 0.18;

export function shaperToLinear(encoded: number) {
  return MIDDLE_GREY * 2 ** (SHAPER_MIN + (SHAPER_MAX - SHAPER_MIN) * encoded);
}

// Stephen Hill's fit of the ACES 1.0 RRT + sRGB ODT, on linear sRGB (no exposure bias).
const ACES_INPUT: Matrix = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
const ACES_OUTPUT: Matrix = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];

export function rrtOdtFit(value: number) {
  return (value * (value + 0.0245786) - 0.000090537) / (value * (0.983729 * value + 0.432951) + 0.238081);
}

/** Linear sRGB in, display-linear sRGB out. */
export function acesFitted(linear: Vector): Vector {
  return mapVector(apply(ACES_OUTPUT, mapVector(apply(ACES_INPUT, linear), rrtOdtFit)), clamp01);
}

// AgX after Filament (google/filament#7236) and three.js r170: Rec.2020 primaries, inset, log2, sigmoid, outset.
const REC709_TO_REC2020: Matrix = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0113], [0.0164, 0.088, 0.8956]];
const REC2020_TO_REC709: Matrix = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const AGX_INSET: Matrix = [
  [0.856627153315983, 0.0951212405381588, 0.0482516061458583],
  [0.137318972929847, 0.761241990602591, 0.101439036467562],
  [0.11189821299995, 0.0767994186031903, 0.811302368396859],
];
const AGX_OUTSET: Matrix = [
  [1.1271005818144368, -0.11060664309660323, -0.016493938717834573],
  [-0.1413297634984383, 1.157823702216272, -0.016493938717834257],
  [-0.14132976349843826, -0.11060664309660294, 1.2519364065950405],
];
const AGX_MIN_EV = -12.47393, AGX_MAX_EV = 4.026069;

/** The iolite polynomial fit of AgX's default contrast sigmoid, on log2-encoded input. */
export function agxSigmoid(x: number) {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

export function agxLogEncode(linear: number) {
  return clamp01((Math.log2(Math.max(linear, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV));
}

/** Linear sRGB in, display-linear sRGB out. */
export function agx(linear: Vector): Vector {
  const inset = apply(AGX_INSET, apply(REC709_TO_REC2020, linear));
  const shaped = apply(AGX_OUTSET, mapVector(inset, value => agxSigmoid(agxLogEncode(value))));
  return mapVector(apply(REC2020_TO_REC709, mapVector(shaped, value => Math.max(0, value) ** 2.2)), clamp01);
}

// Machado, Oliveira & Fernandes (2009), severity 1.0, on linear sRGB.
export const MACHADO: Record<"protan" | "deutan" | "tritan", Matrix> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

// ACES 1.3 Reference Gamut Compression: thresholds and limits per cyan, magenta, yellow.
const RGC_THRESHOLD: Vector = [0.815, 0.803, 0.88];
const RGC_LIMIT: Vector = [1.147, 1.264, 1.312];
const RGC_POWER = 1.2;

function compressDistance(distance: number, limit: number, threshold: number) {
  if (distance < threshold) return distance;
  const scale = (limit - threshold) / ((((1 - threshold) / (limit - threshold)) ** -RGC_POWER - 1) ** (1 / RGC_POWER));
  const normalised = (distance - threshold) / scale;
  return threshold + scale * normalised / ((1 + normalised ** RGC_POWER) ** (1 / RGC_POWER));
}

/** Linear AP1 in and out: each channel's distance from the achromatic, compressed toward the gamut. */
export function referenceGamutCompress(ap1: Vector): Vector {
  const achromatic = Math.max(...ap1);
  if (achromatic === 0) return ap1;
  return mapVector(ap1, (value, channel) => {
    const distance = (achromatic - value) / Math.abs(achromatic);
    return achromatic - compressDistance(distance, RGC_LIMIT[channel], RGC_THRESHOLD[channel]) * Math.abs(achromatic);
  });
}

const RGC_SOURCE: GamutId = "dwg";
// Source linear RGB → linear Rec.709 → AP1 (via XYZ, Bradford D65→D60), built from the shared gamut tables.
const REC709_TO_AP1: Matrix = (() => {
  const toRec709 = (rgb: Vector) => gamutToRec709("ap1", rgb);
  const ap1ToRec709: Matrix = [0, 1, 2].map(row => [0, 1, 2].map(column =>
    toRec709(column === 0 ? [1, 0, 0] : column === 1 ? [0, 1, 0] : [0, 0, 1])[row])) as unknown as Matrix;
  return invert(ap1ToRec709);
})();
const AP1_TO_REC709 = invert(REC709_TO_AP1);

export function sourceToAp1(linear: Vector): Vector {
  return apply(REC709_TO_AP1, gamutToRec709(RGC_SOURCE, linear));
}

/** Where a lattice point starts and ends, in RGB, and how it looks at each end. */
type Ends = { input: Vector; output: Vector; inputColor: Vector; outputColor: Vector };

const display = (linear: Vector) => mapVector(linear, value => srgbEncode(clamp01(value)));

function ends(id: TransformId, lattice: Vector): Ends {
  if (id === "aces" || id === "agx") {
    const output = display((id === "aces" ? acesFitted : agx)(mapVector(lattice, shaperToLinear)));
    // A log image straight to the screen: flat and grey, as an ungraded camera file looks.
    return { input: lattice, output, inputColor: lattice, outputColor: output };
  }
  if (id === "rgc") {
    const input = sourceToAp1(lattice);
    const output = referenceGamutCompress(input);
    return { input, output, inputColor: display(apply(AP1_TO_REC709, input)), outputColor: display(apply(AP1_TO_REC709, output)) };
  }
  const simulated = apply(MACHADO[id], mapVector(lattice, srgbDecode));
  const output = mapVector(simulated, value => Math.sign(value) * srgbEncode(Math.abs(value)));
  return { input: lattice, output, inputColor: lattice, outputColor: display(simulated) };
}

// The cube stood on its black corner: the neutral axis runs straight up the middle.
const STAND: Matrix = multiply([[1.2, 0, 0], [0, 1.2, 0], [0, 0, 1.2]], [
  [1 / Math.SQRT2, -1 / Math.SQRT2, 0],
  [1 / Math.sqrt(6), 1 / Math.sqrt(6), -2 / Math.sqrt(6)],
  [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
]);
const STAND_LIFT = 1.2 * Math.sqrt(3) / 2;

export function stand(rgb: Vector): Vector {
  const [x, y, z] = apply(STAND, rgb);
  return [x, y, z - STAND_LIFT];
}

export type TransformLattice = {
  runs: { from: Ends; to: Ends; edge: boolean }[];
  reference: WireSegment[];
  marks: VolumeMark[];
};

const cache = new Map<TransformId, TransformLattice>();

export function transformLattice(id: TransformId): TransformLattice {
  const cached = cache.get(id);
  if (cached) return cached;
  const runs = cubeRuns(cubeLines(5), 12).map(({ start, end, edge }) => ({ from: ends(id, start), to: ends(id, end), edge }));
  const reference = cubeLines(0).map(line => ({ from: stand(line.from), to: stand(line.to), color: [0.6, 0.6, 0.6] as Vector, edge: true }));
  const corners = [["R", [1, 0, 0]], ["G", [0, 1, 0]], ["B", [0, 0, 1]], ["W", [1, 1, 1]]] as const;
  const lattice = { runs, reference, marks: corners.map(([label, rgb]) => ({ at: mapVector(stand(rgb), value => value * 1.12), label })) };
  cache.set(id, lattice);
  return lattice;
}

/** The lattice `amount` of the way from its inputs (0) to its outputs (1). */
export function transformVolume(lattice: TransformLattice, amount: number): ColorVolume {
  const segments = lattice.runs.map(({ from, to, edge }) => ({
    from: stand(lerpVector(from.input, from.output, amount)),
    to: stand(lerpVector(to.input, to.output, amount)),
    color: lerpVector(from.inputColor, from.outputColor, amount),
    edge,
  }));
  return { segments, axes: [], reference: lattice.reference, marks: lattice.marks };
}
