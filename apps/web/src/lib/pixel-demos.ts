/** Pixel-level demonstrations: chroma subsampling, quantisation, a Bayer sensor, pigment mixing. */

import { displayRgb, lerp, mapVector, srgbDecode, srgbEncode, type Vector } from "./color-math";
import { D65_SPD } from "./color-science-data";
import { WAVELENGTHS, spectrumToXyz } from "./spectral";

export const PIXEL_VIEWS = ["subsampling", "bitdepth", "bayer", "mixing"] as const;
export type PixelView = (typeof PIXEL_VIEWS)[number];
export const PIXEL_LABELS: Record<PixelView, string> = {
  subsampling: "色度抽样 · Rec.709 Y′CbCr",
  bitdepth: "位深 · 暗部 0–8% 放大 12.5 倍",
  bayer: "拜耳阵列 · RGGB 与双线性去马赛克",
  mixing: "加色与减色 · Kubelka–Munk 示意",
};

export const PATCH_WIDTH = 16, PATCH_HEIGHT = 12;
export type Image = Vector[][];

/** A small test patch, encoded R′G′B′: a sky ramp, a red disc, a thin yellow line, fine stripes. */
export function testPatch(): Image {
  return Array.from({ length: PATCH_HEIGHT }, (_, y) => Array.from({ length: PATCH_WIDTH }, (_, x): Vector => {
    if (x >= 12 && y >= 6) return (x + y) % 2 ? [0.95, 0.95, 0.95] : [0.08, 0.08, 0.08];
    // Leave headroom where the red disc and yellow line share chroma, so display clipping cannot change Y′.
    if ((x - 5.5) ** 2 + (y - 5.5) ** 2 < 11) return [0.76, 0.2, 0.23];
    if (Math.abs(x - y - 2) < 0.5) return [0.84, 0.7, 0.25];
    return [lerp(0.1, 0.2, x / PATCH_WIDTH), lerp(0.28, 0.62, y / PATCH_HEIGHT), lerp(0.62, 0.78, y / PATCH_HEIGHT)];
  }));
}

export const SUBSAMPLING_MODES = ["4:4:4", "4:2:2", "4:2:0"] as const;
export type SubsamplingMode = (typeof SUBSAMPLING_MODES)[number];

function toYCbCr([r, g, b]: Vector): Vector {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [luma, (b - luma) / 1.8556, (r - luma) / 1.5748];
}

function fromYCbCr([luma, cb, cr]: Vector): Vector {
  const r = luma + 1.5748 * cr, b = luma + 1.8556 * cb;
  return [r, (luma - 0.2126 * r - 0.0722 * b) / 0.7152, b];
}

/**
 * Keeps every luma sample and averages chroma over 2×1 or 2×2 blocks, then
 * rebuilds each pixel from its block's chroma (nearest neighbour, as the eye sees it worst).
 * Chroma sits in each block's centre.
 */
export function subsample(image: Image, mode: SubsamplingMode) {
  const across = mode === "4:4:4" ? 1 : 2, down = mode === "4:2:0" ? 2 : 1;
  const ycc = image.map(row => row.map(toYCbCr));
  const samples: { x: number; y: number }[] = [];
  const rebuilt = ycc.map(row => row.map(() => [0, 0, 0] as Vector));
  for (let top = 0; top < PATCH_HEIGHT; top += down) {
    for (let left = 0; left < PATCH_WIDTH; left += across) {
      let cb = 0, cr = 0;
      for (let y = top; y < top + down; y++) for (let x = left; x < left + across; x++) { cb += ycc[y][x][1]; cr += ycc[y][x][2]; }
      cb /= across * down; cr /= across * down;
      samples.push({ x: left + across / 2, y: top + down / 2 });
      for (let y = top; y < top + down; y++) for (let x = left; x < left + across; x++) rebuilt[y][x] = fromYCbCr([ycc[y][x][0], cb, cr]);
    }
  }
  return { image: rebuilt, chromaSamples: samples };
}

export function quantise(value: number, bits: number) {
  const levels = 2 ** bits - 1;
  return Math.round(value * levels) / levels;
}

export const BIT_DEPTHS = [6, 8, 10, 12] as const;
export const BIT_DEPTH_WINDOW = 0.08;

/** Which channel an RGGB sensor reads at a photosite: 0 red, 1 green, 2 blue. */
export function bayerChannel(x: number, y: number) {
  return y % 2 === 0 ? (x % 2 === 0 ? 0 : 1) : (x % 2 === 0 ? 1 : 2);
}

/** One value per photosite, in linear light. */
export function mosaic(image: Image) {
  return image.map((row, y) => row.map((pixel, x) => srgbDecode(pixel[bayerChannel(x, y)])));
}

/** Bilinear demosaicing: each missing channel is the mean of its nearest same-colour neighbours. */
export function demosaic(sites: number[][]): Image {
  return sites.map((row, y) => row.map((_, x) => mapVector([0, 0, 0], (__, channel) => {
    if (bayerChannel(x, y) === channel) return srgbEncode(sites[y][x]);
    let sum = 0, count = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || ny >= sites.length || nx >= row.length || bayerChannel(nx, ny) !== channel) continue;
      sum += sites[ny][nx]; count++;
    }
    return srgbEncode(sum / count);
  })));
}

// Idealised pigments, not measured ones: a yellow that reflects from 500 nm up, a blue that reflects 420–520 nm.
export const YELLOW_PIGMENT = WAVELENGTHS.map(wavelength => 0.04 + 0.86 / (1 + Math.exp(-(wavelength - 505) / 10)));
export const BLUE_PIGMENT = WAVELENGTHS.map(wavelength => 0.04 + 0.78 * Math.exp(-0.5 * ((wavelength - 470) / 32) ** 2));

const ratio = (reflectance: number) => (1 - reflectance) ** 2 / (2 * reflectance);
const reflectanceOf = (absorptionToScatter: number) => 1 + absorptionToScatter - Math.sqrt(absorptionToScatter ** 2 + 2 * absorptionToScatter);

/** Kubelka–Munk: K/S adds by concentration; `yellow` is the yellow share, 0–1. */
export function pigmentMix(yellow: number) {
  return YELLOW_PIGMENT.map((value, index) => reflectanceOf(lerp(ratio(BLUE_PIGMENT[index]), ratio(value), yellow)));
}

export function reflectanceColor(reflectance: readonly number[]): Vector {
  return displayRgb(spectrumToXyz(reflectance, D65_SPD));
}

/** Two lights of the pigments' colours added together, `yellow` the yellow share of the power. */
export function lightMix(yellow: number): Vector {
  const mixed = YELLOW_PIGMENT.map((value, index) => lerp(BLUE_PIGMENT[index], value, yellow));
  return reflectanceColor(mixed);
}
