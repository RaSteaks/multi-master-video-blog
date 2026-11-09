/** Spectral colourimetry on the measured CIE tables: loci, blackbodies and limits. */

import { CIE_1931_X, CIE_1931_Y, CIE_1931_Z, D65_SPD, SPECTRUM_START, SPECTRUM_STEP } from "./color-science-data";
import { xyToUv1960, uv1960ToXy, xyzToXy, type Vector } from "./color-math";

export const WAVELENGTHS: readonly number[] = CIE_1931_X.map((_, index) => SPECTRUM_START + index * SPECTRUM_STEP);
export const SPECTRUM_END = WAVELENGTHS[WAVELENGTHS.length - 1];

/** Integrates a spectrum against the 1931 observer, scaled so `illuminant` alone has Y=1. */
export function spectrumToXyz(values: readonly number[], illuminant?: readonly number[]): Vector {
  let x = 0, y = 0, z = 0, norm = 0;
  for (let index = 0; index < values.length; index++) {
    const light = illuminant ? illuminant[index] : 1;
    const weight = values[index] * light;
    x += CIE_1931_X[index] * weight;
    y += CIE_1931_Y[index] * weight;
    z += CIE_1931_Z[index] * weight;
    norm += CIE_1931_Y[index] * light;
  }
  const scale = illuminant ? 1 / norm : 1;
  return [x * scale, y * scale, z * scale];
}

// Second radiation constant as CIE 015 uses it, in m·K.
const C2 = 1.4388e-2;

/** Planck's law, relative: the 1/λ⁵ and exponential terms only. */
export function planck(wavelengthNm: number, kelvin: number) {
  const metres = wavelengthNm * 1e-9;
  return 1 / (metres ** 5 * (Math.exp(C2 / (metres * kelvin)) - 1));
}

/** A blackbody's spectrum on the table's wavelengths, 1 at 560 nm. */
export function blackbody(kelvin: number) {
  const reference = planck(560, kelvin);
  return WAVELENGTHS.map(wavelength => planck(wavelength, kelvin) / reference);
}

export function planckianXy(kelvin: number) {
  return xyzToXy(spectrumToXyz(blackbody(kelvin)));
}

/** CIE daylight locus (CIE 015:2018 eq. 4.7–4.8), 4000–25000 K. */
export function daylightXy(kelvin: number): readonly [number, number] {
  const t = kelvin;
  const x = t <= 7000
    ? -4.607e9 / t ** 3 + 2.9678e6 / t ** 2 + 0.09911e3 / t + 0.244063
    : -2.0064e9 / t ** 3 + 1.9018e6 / t ** 2 + 0.24748e3 / t + 0.23704;
  return [x, -3 * x * x + 2.87 * x - 0.275];
}

/**
 * A line of constant correlated colour temperature: perpendicular to the Planckian
 * locus in CIE 1960 uv, `duv` either side.
 */
export function isotherm(kelvin: number, duv = 0.02) {
  const [u0, v0] = xyToUv1960(...planckianXy(kelvin * 0.995));
  const [u1, v1] = xyToUv1960(...planckianXy(kelvin * 1.005));
  const [u, v] = xyToUv1960(...planckianXy(kelvin));
  const length = Math.hypot(u1 - u0, v1 - v0);
  const normal = [-(v1 - v0) / length, (u1 - u0) / length];
  return [uv1960ToXy(u - normal[0] * duv, v - normal[1] * duv), uv1960ToXy(u + normal[0] * duv, v + normal[1] * duv)] as const;
}

/** Monochromatic stimuli, short to long: the horseshoe's curved edge. */
export function spectralLocus() {
  return WAVELENGTHS.map((wavelength, index) => ({
    wavelength,
    xy: xyzToXy([CIE_1931_X[index], CIE_1931_Y[index], CIE_1931_Z[index]]),
  }));
}

/** The observer at any wavelength in the table, linearly interpolated. */
export function observerAt(wavelength: number): Vector {
  const position = Math.min(WAVELENGTHS.length - 1.000001, Math.max(0, (wavelength - SPECTRUM_START) / SPECTRUM_STEP));
  const index = Math.floor(position), within = position - index;
  const at = (table: readonly number[]) => table[index] + (table[index + 1] - table[index]) * within;
  return [at(CIE_1931_X), at(CIE_1931_Y), at(CIE_1931_Z)];
}

/** True when xy falls inside the horseshoe (the locus closed by the purple line). */
export function insideLocus(x: number, y: number, locus = LOCUS_XY) {
  let inside = false;
  for (let index = 0, previous = locus.length - 1; index < locus.length; previous = index++) {
    const [xi, yi] = locus[index], [xj, yj] = locus[previous];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The ends of the table bend back on themselves; trimming to 380–700 nm keeps the outline simple.
const LOCUS_XY = spectralLocus().filter(({ wavelength }) => wavelength <= 700).map(({ xy }) => xy);

/**
 * MacAdam's optimal colours under D65: every reflectance that is 1 over one unbroken
 * (wrapping) band of wavelengths and 0 elsewhere. `start` and `width` are table steps;
 * width 0 is black and the full width is the perfect white.
 */
export function optimalColor(start: number, width: number): Vector {
  const count = WAVELENGTHS.length;
  const values = WAVELENGTHS.map((_, index) => ((index - start) % count + count) % count < width ? 1 : 0);
  return spectrumToXyz(values, D65_SPD);
}
