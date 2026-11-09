/** Small linear-algebra and encoding helpers shared by the home diagrams. */

export type Vector = readonly [number, number, number];
export type Matrix = readonly [Vector, Vector, Vector];

export function apply(matrix: Matrix, [a, b, c]: Vector): Vector {
  return [
    matrix[0][0] * a + matrix[0][1] * b + matrix[0][2] * c,
    matrix[1][0] * a + matrix[1][1] * b + matrix[1][2] * c,
    matrix[2][0] * a + matrix[2][1] * b + matrix[2][2] * c,
  ];
}

export function multiply(left: Matrix, right: Matrix): Matrix {
  const row = (index: number): Vector => [0, 1, 2].map(column =>
    left[index][0] * right[0][column] + left[index][1] * right[1][column] + left[index][2] * right[2][column]) as unknown as Vector;
  return [row(0), row(1), row(2)];
}

export function invert(m: Matrix): Matrix {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  return [
    [A / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant],
    [B / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant],
    [C / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant],
  ];
}

export const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

export function lerpVector(from: Vector, to: Vector, amount: number): Vector {
  return [lerp(from[0], to[0], amount), lerp(from[1], to[1], amount), lerp(from[2], to[2], amount)];
}

export function mapVector(vector: Vector, map: (value: number, index: number) => number): Vector {
  return [map(vector[0], 0), map(vector[1], 1), map(vector[2], 2)];
}

/** A power that keeps its sign, so out-of-gamut negatives stay on their own side. */
export function signedPow(value: number, power: number) {
  return Math.sign(value) * Math.abs(value) ** power;
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// IEC 61966-2-1.
export function srgbEncode(linear: number) {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
}

export function srgbDecode(encoded: number) {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

export const REC709_TO_XYZ: Matrix = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]];
export const XYZ_TO_REC709: Matrix = invert(REC709_TO_XYZ);
export const D65_WHITE: Vector = apply(REC709_TO_XYZ, [1, 1, 1]);

/** Encoded sRGB for drawing a D65 colour: out-of-gamut channels clip, so the hue reads. */
export function displayRgb(xyz: Vector): Vector {
  return mapVector(apply(XYZ_TO_REC709, xyz), value => srgbEncode(clamp01(value)));
}

/** Scales an emission colour so its brightest channel is full, before clipping. */
export function brightestRgb(xyz: Vector): Vector {
  const linear = mapVector(apply(XYZ_TO_REC709, xyz), value => Math.max(0, value));
  const peak = Math.max(...linear) || 1;
  return mapVector(linear, value => srgbEncode(value / peak));
}

export function cssRgb([r, g, b]: Vector, alpha = 1) {
  return `rgb(${Math.round(clamp01(r) * 255)} ${Math.round(clamp01(g) * 255)} ${Math.round(clamp01(b) * 255)} / ${alpha})`;
}

export function xyzToXy([x, y, z]: Vector): readonly [number, number] {
  const sum = x + y + z;
  return [x / sum, y / sum];
}

export function xyToXyz(x: number, y: number, luminance = 1): Vector {
  return [x * luminance / y, luminance, (1 - x - y) * luminance / y];
}

// CIE 1976 UCS.
export function xyToUvPrime(x: number, y: number): readonly [number, number] {
  const denominator = -2 * x + 12 * y + 3;
  return [4 * x / denominator, 9 * y / denominator];
}

// CIE 1960 UCS, where correlated colour temperature is defined.
export function xyToUv1960(x: number, y: number): readonly [number, number] {
  const denominator = -2 * x + 12 * y + 3;
  return [4 * x / denominator, 6 * y / denominator];
}

export function uv1960ToXy(u: number, v: number): readonly [number, number] {
  const denominator = 2 * u - 8 * v + 4;
  return [3 * u / denominator, 2 * v / denominator];
}

/** Smooth 0→1 over [start, end]. */
export function ease(value: number, start = 0, end = 1) {
  const t = clamp01((value - start) / (end - start));
  return t * t * (3 - 2 * t);
}
