/** Canvas drawing for the flat home diagrams: chromaticity, spectra and curves. */

import {
  UV_FRAME,
  XY_FRAME,
  daylightLocus,
  gamutTriangles,
  hueLines,
  inFrame,
  isotherms,
  locus,
  macadamEllipses,
  planckianLocus,
  whitePoints,
  type ChromaticityView,
  type Point,
} from "./chromaticity";
import { brightestRgb, cssRgb, lerp, srgbEncode, xyToUvPrime, xyToXyz, type Vector } from "./color-math";
import {
  CIE_1931_X,
  CIE_1931_Y,
  CIE_1931_Z,
  METAMER_BASE,
  METAMER_PAIR,
  TM30_SOURCES,
  WRIGHT_GUILD_B,
  WRIGHT_GUILD_G,
  WRIGHT_GUILD_R,
} from "./color-science-data";
import { GAMUT_LABELS, GAMUTS } from "./color-volume";
import { cycle, cycleFrames, morph, morphFrames, sweep, sweepFrames } from "./diagram-motion";
import { FONT, ink, type Size } from "./scope-drawing";
import { SPECTRUM_END, WAVELENGTHS, blackbody, insideLocus, observerAt } from "./spectral";
import { blackbodyColor, cameraFit, metamerScene, tm30Frame, type SpectrumView } from "./spectrum-views";
import {
  FILM,
  STOPS_RANGE,
  TONE_CURVES,
  TRANSFER_CURVES,
  filmDensity,
  stopsToLinear,
  type Curve,
  type CurveView,
} from "./transfer-curves";

export type Frame = { left: number; top: number; width: number; height: number };
type Scale = { x: (value: number) => number; y: (value: number) => number };
type Pixel = readonly [number, number];

/** The plotting area, inset for tick labels on the left and below. */
export function plotFrame({ side }: Size, height = 0.74): Frame {
  const width = side * 0.8;
  return { left: side * 0.13, top: side * (0.5 - height / 2) - side * 0.01, width, height: side * height };
}

function scaled(frame: Frame, [x0, x1]: readonly [number, number], [y0, y1]: readonly [number, number]): Scale {
  return {
    x: value => frame.left + (value - x0) / (x1 - x0) * frame.width,
    y: value => frame.top + frame.height - (value - y0) / (y1 - y0) * frame.height,
  };
}

type TextOptions = { align?: CanvasTextAlign; alpha?: number; color?: string; baseline?: CanvasTextBaseline; size?: number };

export function text({ context }: Size, value: string, x: number, y: number, options: TextOptions = {}) {
  context.font = options.size ? FONT.replace("10px", `${options.size}px`) : FONT;
  context.fillStyle = options.color ?? ink(options.alpha ?? 0.6);
  context.textAlign = options.align ?? "left";
  context.textBaseline = options.baseline ?? "middle";
  context.fillText(value, x, y);
}

export function stroke({ context }: Size, points: readonly Pixel[], style: string, width = 1, dash: number[] = []) {
  if (points.length < 2) return;
  context.strokeStyle = style;
  context.lineWidth = width;
  context.setLineDash(dash);
  context.beginPath();
  context.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) context.lineTo(x, y);
  context.stroke();
  context.setLineDash([]);
}

function dot({ context }: Size, [x, y]: Pixel, radius: number, fill: string) {
  context.fillStyle = fill;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

type Tick = { value: number; label?: string };

/** A frame with ticks on its left and bottom edges and a faint grid at each tick. */
export function axes(size: Size, frame: Frame, scale: Scale, xTicks: Tick[], yTicks: Tick[], xLabel = "", yLabel = "") {
  const { context } = size;
  const bottom = frame.top + frame.height, right = frame.left + frame.width;
  context.lineWidth = 1;
  for (const tick of xTicks) {
    const x = Math.round(scale.x(tick.value)) + 0.5;
    stroke(size, [[x, frame.top], [x, bottom]], ink(0.08));
    if (tick.label) text(size, tick.label, x, bottom + 11, { align: "center", alpha: 0.5 });
  }
  for (const tick of yTicks) {
    const y = Math.round(scale.y(tick.value)) + 0.5;
    stroke(size, [[frame.left, y], [right, y]], ink(0.08));
    if (tick.label) text(size, tick.label, frame.left - 6, y, { align: "right", alpha: 0.5 });
  }
  stroke(size, [[frame.left, frame.top], [frame.left, bottom], [right, bottom]], ink(0.34));
  if (xLabel) text(size, xLabel, right, bottom + 24, { align: "right", alpha: 0.6 });
  if (yLabel) text(size, yLabel, frame.left, frame.top - 12, { align: "left", alpha: 0.6 });
}

/** A heading in the plot's top corner: what the moving part is showing right now. */
function readout(size: Size, frame: Frame, lines: string[], color?: string) {
  lines.forEach((line, index) => text(size, line, frame.left + frame.width, frame.top + 4 + index * 14, {
    align: "right", alpha: index === 0 ? 0.9 : 0.55, color: index === 0 ? color : undefined,
  }));
}

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, index) => from + index * step);

// ── Chromaticity ─────────────────────────────────────────────────────────────

const horseshoes = new Map<number, HTMLCanvasElement>();

/** The horseshoe filled with each chromaticity at full brightness, once per size. */
function horseshoe(side: number) {
  const pixels = Math.max(1, Math.round(side));
  const cached = horseshoes.get(pixels);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = pixels;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const image = context.createImageData(pixels, pixels);
  for (let row = 0; row < pixels; row++) {
    for (let column = 0; column < pixels; column++) {
      const x = XY_FRAME.left + (column + 0.5) / pixels * XY_FRAME.side;
      const y = XY_FRAME.bottom + (1 - (row + 0.5) / pixels) * XY_FRAME.side;
      if (!insideLocus(x, y)) continue;
      const [r, g, b] = brightestRgb(xyToXyz(x, y, 1));
      const at = (row * pixels + column) * 4;
      image.data[at] = r * 255; image.data[at + 1] = g * 255; image.data[at + 2] = b * 255; image.data[at + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  horseshoes.clear();
  horseshoes.set(pixels, canvas);
  return canvas;
}

function squareFrame({ side }: Size): Frame {
  const width = side * 0.76;
  return { left: side * 0.15, top: side * 0.08, width, height: width };
}

function framePixel(frame: Frame, [u, v]: Point): Pixel {
  return [frame.left + u * frame.width, frame.top + (1 - v) * frame.height];
}

const LOCUS_LABELS = [460, 480, 500, 520, 540, 560, 580, 600, 620];
const GAMUT_STAGE_SECONDS = 2.8;

function drawLocus(size: Size, frame: Frame, place: (xy: Point) => Point, labels: boolean) {
  const points = locus();
  const outline = [...points.map(({ xy }) => framePixel(frame, place(xy))), framePixel(frame, place(points[0].xy))];
  stroke(size, outline, ink(0.55), 1.2);
  if (!labels) return;
  for (const { wavelength, xy } of points.filter(({ wavelength }) => LOCUS_LABELS.includes(wavelength))) {
    const [x, y] = framePixel(frame, place(xy));
    const [cx, cy] = framePixel(frame, place([0.3127, 0.329]));
    const length = Math.hypot(x - cx, y - cy) || 1;
    text(size, String(wavelength), x + (x - cx) / length * 14, y + (y - cy) / length * 14, { align: "center", alpha: 0.45 });
  }
}

function chromaticityAxes(size: Size, frame: Frame, frameSpec: typeof XY_FRAME, labels: readonly [string, string]) {
  const scale = scaled(frame, [frameSpec.left, frameSpec.left + frameSpec.side], [frameSpec.bottom, frameSpec.bottom + frameSpec.side]);
  const ticks = range(0, 0.8, 0.1).map((value, index) => ({ value, label: index % 2 === 0 ? value.toFixed(1) : undefined }));
  axes(size, frame, scale, ticks, ticks, labels[0], labels[1]);
}

function drawGamuts(size: Size, frame: Frame, seconds: number) {
  const { context } = size;
  const place = (xy: Point) => inFrame(xy, XY_FRAME);
  chromaticityAxes(size, frame, XY_FRAME, ["x", "y"]);
  context.globalAlpha = 0.5;
  context.drawImage(horseshoe(frame.width), frame.left, frame.top, frame.width, frame.height);
  context.globalAlpha = 1;
  drawLocus(size, frame, place, true);

  stroke(size, planckianLocus().map(xy => framePixel(frame, place(xy))), ink(0.7), 1);
  stroke(size, daylightLocus().map(xy => framePixel(frame, place(xy))), ink(0.45), 1, [3, 3]);
  for (const { kelvin, ends } of isotherms()) {
    const [from, to] = ends.map(xy => framePixel(frame, place(xy)));
    stroke(size, [from, to], ink(0.5));
    if (kelvin === 2000 || kelvin === 6500) text(size, `${kelvin}K`, to[0] + 2, to[1] - 7, { alpha: 0.5 });
  }

  const triangles = gamutTriangles();
  const { index } = cycle(seconds, GAMUT_STAGE_SECONDS, triangles.length);
  // Imaginary primaries (AP0, DaVinci WG) lie off the chart; their sides run out of it.
  context.save();
  context.beginPath();
  context.rect(frame.left, frame.top, frame.width, frame.height);
  context.clip();
  triangles.forEach(({ corners }, at) => {
    const points = [...corners, corners[0]].map(xy => framePixel(frame, place(xy)));
    stroke(size, points, at === index ? ink(0.95) : ink(0.16), at === index ? 1.6 : 0.8);
  });
  context.restore();
  const shown = triangles[index];
  shown.corners.filter(([x, y]) => x >= XY_FRAME.left && y >= XY_FRAME.bottom)
    .forEach(xy => dot(size, framePixel(frame, place(xy)), 2.6, ink(0.95)));
  const white = whitePoints.find(point => point.gamuts.includes(shown.gamut))!;
  dot(size, framePixel(frame, place(white.xy)), 2.2, ink(0.95));
  readout(size, frame, [GAMUT_LABELS[shown.gamut], `白点 ${white.label} · 实线 普朗克 · 虚线 日光`]);
}

function drawMacadam(size: Size, frame: Frame, seconds: number) {
  const amount = morph(seconds);
  const place = (xy: Point): Point => {
    const a = inFrame(xy, XY_FRAME), b = inFrame(xyToUvPrime(...xy), UV_FRAME);
    return [lerp(a[0], b[0], amount), lerp(a[1], b[1], amount)];
  };
  const { context } = size;
  stroke(size, [[frame.left, frame.top], [frame.left, frame.top + frame.height], [frame.left + frame.width, frame.top + frame.height]], ink(0.34));
  context.globalAlpha = 1 - amount;
  text(size, "x", frame.left + frame.width, frame.top + frame.height + 14, { align: "right" });
  text(size, "y", frame.left, frame.top - 10);
  context.globalAlpha = amount;
  text(size, "u′", frame.left + frame.width, frame.top + frame.height + 14, { align: "right" });
  text(size, "v′", frame.left, frame.top - 10);
  context.globalAlpha = 1;
  drawLocus(size, frame, place, amount < 0.05 || amount > 0.95);

  for (const ellipse of macadamEllipses()) {
    const points = ellipse.xy.map((xy, index) => {
      const a = inFrame(xy, XY_FRAME), b = inFrame(ellipse.uv[index], UV_FRAME);
      return framePixel(frame, [lerp(a[0], b[0], amount), lerp(a[1], b[1], amount)]);
    });
    context.fillStyle = cssRgb(ellipse.color, 0.28);
    context.beginPath();
    points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
    context.fill();
    stroke(size, points, cssRgb(ellipse.color, 0.95), 1);
  }
  readout(size, frame, [amount < 0.5 ? "CIE 1931 xy" : "CIE 1976 u′v′", "每个椭圆内的颜色难以分辨"]);
}

function drawHueLines(size: Size, frame: Frame, seconds: number) {
  const { context } = size;
  const place = (xy: Point) => inFrame(xy, XY_FRAME);
  chromaticityAxes(size, frame, XY_FRAME, ["x", "y"]);
  context.globalAlpha = 0.18;
  context.drawImage(horseshoe(frame.width), frame.left, frame.top, frame.width, frame.height);
  context.globalAlpha = 1;
  drawLocus(size, frame, place, false);
  // Alternate which model leads, so each line can be followed on its own.
  const lab = 0.35 + 0.65 * (1 - morph(seconds)), ok = 0.35 + 0.65 * morph(seconds);
  for (const line of hueLines()) {
    stroke(size, line.lab.map(xy => framePixel(frame, place(xy))), cssRgb(line.color, lab), 1.4);
    stroke(size, line.ok.map(xy => framePixel(frame, place(xy))), cssRgb(line.color, ok), 1.4, [4, 3]);
  }
  dot(size, framePixel(frame, place([0.3127, 0.329])), 2.2, ink(0.9));
  readout(size, frame, [morph(seconds) < 0.5 ? "实线 · CIELAB" : "虚线 · Oklab", "L* = 50，每 30° 一条；看蓝色那条"]);
}

export function drawChromaticity(size: Size, view: ChromaticityView, seconds: number) {
  const frame = squareFrame(size);
  if (view === "gamuts") drawGamuts(size, frame, seconds);
  else if (view === "macadam") drawMacadam(size, frame, seconds);
  else drawHueLines(size, frame, seconds);
}

export const CHROMATICITY_FRAMES = {
  gamuts: cycleFrames(GAMUT_STAGE_SECONDS, GAMUTS.map(gamut => GAMUT_LABELS[gamut])),
  macadam: morphFrames("CIE 1931 xy", "CIE 1976 u′v′"),
  hue: morphFrames("CIELAB", "Oklab"),
};

// ── Spectra ──────────────────────────────────────────────────────────────────

const WAVELENGTH_RANGE = [WAVELENGTHS[0], SPECTRUM_END] as const;
const wavelengthTicks = range(400, 750, 50).map(value => ({ value, label: value % 100 === 0 ? String(value) : undefined }));
const OBSERVER_SWEEP_SECONDS = 14;
const BLACKBODY_SWEEP_SECONDS = 12;
const TM30_STAGE_SECONDS = 4;
const CAMERA_STAGE_SECONDS = 3;
const CAMERA_CHANNELS = ["R", "G", "B"];

function spectrumStrip(size: Size, frame: Frame, scale: Scale) {
  const { context } = size;
  const y = frame.top + frame.height + 2;
  for (let wavelength = WAVELENGTH_RANGE[0]; wavelength < WAVELENGTH_RANGE[1]; wavelength += 2) {
    const brightness = Math.min(1, observerAt(wavelength)[1] * 3);
    context.fillStyle = cssRgb(brightestRgb(observerAt(wavelength)), 0.75 * brightness);
    context.fillRect(scale.x(wavelength), y, scale.x(wavelength + 2) - scale.x(wavelength) + 0.5, 3);
  }
}

function curve(scale: Scale, values: readonly number[]): Pixel[] {
  return values.map((value, index) => [scale.x(WAVELENGTHS[index]), scale.y(value)]);
}

const CHANNEL_INK: readonly Vector[] = [[1, 0.42, 0.42], [0.45, 1, 0.55], [0.5, 0.65, 1]];

function cursorSweep(size: Size, frame: Frame, scale: Scale, seconds: number, tables: readonly (readonly number[])[]) {
  const wavelength = Math.round(lerp(400, 700, sweep(seconds, OBSERVER_SWEEP_SECONDS)));
  const x = scale.x(wavelength);
  const color = brightestRgb(observerAt(wavelength));
  stroke(size, [[x, frame.top], [x, frame.top + frame.height]], cssRgb(color, 0.8), 1);
  const position = (wavelength - WAVELENGTHS[0]) / (WAVELENGTHS[1] - WAVELENGTHS[0]);
  const index = Math.floor(position), within = position - index;
  tables.forEach((table, channel) => {
    const value = lerp(table[index], table[Math.min(table.length - 1, index + 1)], within);
    dot(size, [x, scale.y(value)], 3, cssRgb(CHANNEL_INK[channel], 1));
  });
  const swatch = size.side * 0.07;
  size.context.fillStyle = cssRgb(color, 1);
  size.context.fillRect(frame.left + frame.width - swatch, frame.top + 30, swatch, swatch);
  return wavelength;
}

function drawObserver(size: Size, seconds: number, rgb: boolean) {
  const frame = plotFrame(size);
  const tables = rgb ? [WRIGHT_GUILD_R, WRIGHT_GUILD_G, WRIGHT_GUILD_B] : [CIE_1931_X, CIE_1931_Y, CIE_1931_Z];
  const yRange = rgb ? [-0.12, 0.4] as const : [0, 1.9] as const;
  const scale = scaled(frame, WAVELENGTH_RANGE, yRange);
  axes(size, frame, scale, wavelengthTicks,
    (rgb ? range(-0.1, 0.3, 0.1) : range(0, 1.5, 0.5)).map(value => ({ value, label: value.toFixed(1) })),
    "λ nm", rgb ? "r̄ ḡ b̄" : "x̄ ȳ z̄");
  if (rgb) {
    const zero = scale.y(0);
    stroke(size, [[frame.left, zero], [frame.left + frame.width, zero]], ink(0.4));
    // Below zero, the red primary had to be added to the test light instead.
    size.context.fillStyle = cssRgb(CHANNEL_INK[0], 0.16);
    size.context.beginPath();
    size.context.moveTo(scale.x(WAVELENGTHS[0]), zero);
    WRIGHT_GUILD_R.forEach((value, index) => size.context.lineTo(scale.x(WAVELENGTHS[index]), scale.y(Math.min(0, value))));
    size.context.lineTo(scale.x(SPECTRUM_END), zero);
    size.context.fill();
  }
  spectrumStrip(size, frame, scale);
  tables.forEach((table, channel) => stroke(size, curve(scale, table), cssRgb(CHANNEL_INK[channel], 0.9), 1.4));
  const wavelength = cursorSweep(size, frame, scale, seconds, tables);
  readout(size, frame, [`${wavelength} nm`, rgb ? "原色 700 / 546.1 / 435.8 nm" : "2° 标准观察者"]);
}

function drawBlackbody(size: Size, seconds: number) {
  const frame = plotFrame(size);
  const scale = scaled(frame, WAVELENGTH_RANGE, [0, 1.08]);
  axes(size, frame, scale, wavelengthTicks, [{ value: 0, label: "0" }, { value: 0.5 }, { value: 1, label: "1" }], "λ nm", "相对功率（归一到峰值）");
  spectrumStrip(size, frame, scale);
  const normalised = (kelvin: number) => {
    const values = blackbody(kelvin);
    const peak = Math.max(...values);
    return values.map(value => value / peak);
  };
  for (const kelvin of [2000, 3000, 5000, 10000]) stroke(size, curve(scale, normalised(kelvin)), ink(0.14), 1);
  const kelvin = Math.round(2000 * 5 ** sweep(seconds, BLACKBODY_SWEEP_SECONDS) / 50) * 50;
  const color = blackbodyColor(kelvin);
  const points = curve(scale, normalised(kelvin));
  const { context } = size;
  context.fillStyle = cssRgb(color, 0.16);
  context.beginPath();
  context.moveTo(points[0][0], scale.y(0));
  points.forEach(([x, y]) => context.lineTo(x, y));
  context.lineTo(points[points.length - 1][0], scale.y(0));
  context.fill();
  stroke(size, points, cssRgb(color, 1), 1.6);
  const swatch = size.side * 0.07;
  context.fillStyle = cssRgb(color, 1);
  context.fillRect(frame.left + frame.width - swatch, frame.top + 30, swatch, swatch);
  readout(size, frame, [`${kelvin} K`, "普朗克定律 × CIE 1931"]);
}

function drawMetamers(size: Size, seconds: number) {
  const frame = plotFrame(size);
  const scale = scaled(frame, WAVELENGTH_RANGE, [0, 1]);
  axes(size, frame, scale, wavelengthTicks, [{ value: 0, label: "0" }, { value: 0.5, label: "0.5" }, { value: 1, label: "1" }], "λ nm", "反射率");
  const toA = morph(seconds);
  const scene = metamerScene(toA);
  const peak = Math.max(...scene.illuminant);
  stroke(size, curve(scale, scene.illuminant.map(value => value / peak)), ink(0.3), 1, [3, 3]);
  stroke(size, curve(scale, METAMER_BASE), cssRgb(scene.colors[0], 1), 1.6);
  stroke(size, curve(scale, METAMER_PAIR), cssRgb(scene.colors[1], 1), 1.6, [5, 3]);
  const swatch = size.side * 0.1, gap = 4;
  const { context } = size;
  scene.colors.forEach((color, index) => {
    const left = frame.left + frame.width - (swatch + gap) * (2 - index) + gap;
    context.fillStyle = cssRgb(color, 1);
    context.fillRect(left, frame.top + 34, swatch, swatch);
    text(size, index ? "虚线" : "实线", left + swatch / 2, frame.top + 42 + swatch, { align: "center", alpha: 0.5 });
  });
  const light = toA < 0.02 ? "D65" : toA > 0.98 ? "A（2856 K）" : `D65 → A ${Math.round(toA * 100)}%`;
  readout(size, frame, [light, `ΔE*ab = ${scene.deltaE.toFixed(1)} · 虚线为光源`]);
}

function drawTm30(size: Size, seconds: number) {
  const { context, side } = size;
  const center = side / 2, radius = side * 0.3;
  const { index } = cycle(seconds, TM30_STAGE_SECONDS, TM30_SOURCES.length);
  const frame = tm30Frame(index);
  const point = ([x, y]: readonly [number, number]): Pixel => [center + x * radius, center - y * radius];
  frame.reference.forEach((angle, bin) => {
    const start = angle - Math.PI / 16, end = angle + Math.PI / 16;
    const hue = ((angle * 180 / Math.PI) + 360) % 360;
    context.fillStyle = `hsl(${hue} 70% 55% / 0.14)`;
    context.beginPath();
    context.moveTo(center, center);
    context.arc(center, center, radius * 1.32, -end, -start);
    context.closePath();
    context.fill();
    const from = point([Math.cos(angle), Math.sin(angle)]), to = point(frame.test[bin]);
    stroke(size, [from, to], `hsl(${hue} 80% 65% / 0.95)`, 1.4);
    dot(size, to, 2, `hsl(${hue} 80% 70% / 1)`);
  });
  context.strokeStyle = ink(0.45);
  context.setLineDash([3, 3]);
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  stroke(size, [...frame.test, frame.test[0]].map(point), ink(0.9), 1.3);
  text(size, frame.label, side * 0.06, side * 0.08, { alpha: 0.9 });
  text(size, `${frame.cct} K · Rf ${frame.rf} · Rg ${frame.rg}`, side * 0.06, side * 0.08 + 14, { alpha: 0.55 });
  text(size, "虚线圆 = 参考光源", side * 0.94, side * 0.92, { align: "right", alpha: 0.45 });
}

function drawCamera(size: Size, seconds: number) {
  const frame = plotFrame(size);
  // The unconstrained observer fit crosses zero and can peak above the measured channels.
  const scale = scaled(frame, WAVELENGTH_RANGE, [-0.2, 1.2]);
  const ticks = [-0.2, 0, 0.5, 1, 1.2].map(value => ({ value, label: String(value) }));
  axes(size, frame, scale, wavelengthTicks, ticks, "λ nm", "相对灵敏度");
  const zero = scale.y(0);
  stroke(size, [[frame.left, zero], [frame.left + frame.width, zero]], ink(0.34));
  spectrumStrip(size, frame, scale);
  const { index } = cycle(seconds, CAMERA_STAGE_SECONDS, CAMERA_CHANNELS.length);
  cameraFit.camera.forEach((channel, at) => {
    const alpha = at === index ? 1 : 0.3;
    stroke(size, curve(scale, channel), cssRgb(CHANNEL_INK[at], alpha), at === index ? 1.8 : 1);
    stroke(size, curve(scale, cameraFit.fitted[at]), cssRgb(CHANNEL_INK[at], alpha * 0.85), 1, [4, 3]);
  });
  const channel = CAMERA_CHANNELS[index];
  readout(size, frame, [`${channel} 偏离 ${Math.round(cameraFit.residual[index] * 100)}%`, "实线 NPL 实测 · 虚线 x̄ȳz̄ 最佳组合"], cssRgb(CHANNEL_INK[index], 1));
}


export function drawSpectrum(size: Size, view: SpectrumView, seconds: number) {
  if (view === "cmf") drawObserver(size, seconds, false);
  else if (view === "rgbcmf") drawObserver(size, seconds, true);
  else if (view === "blackbody") drawBlackbody(size, seconds);
  else if (view === "metamer") drawMetamers(size, seconds);
  else if (view === "tm30") drawTm30(size, seconds);
  else drawCamera(size, seconds);
}

const observerFrames = sweepFrames(OBSERVER_SWEEP_SECONDS, ["400 nm", "550 nm", "700 nm"]);
export const SPECTRUM_FRAMES = {
  cmf: observerFrames,
  rgbcmf: observerFrames,
  blackbody: sweepFrames(BLACKBODY_SWEEP_SECONDS, ["2000 K", "中间色温", "10000 K"]),
  metamer: morphFrames("D65", "A（2856 K）"),
  tm30: cycleFrames(TM30_STAGE_SECONDS, TM30_SOURCES.map(source => source.label)),
  camera: cycleFrames(CAMERA_STAGE_SECONDS, CAMERA_CHANNELS),
};

// ── Curves ───────────────────────────────────────────────────────────────────

const stopTicks = range(STOPS_RANGE[0], STOPS_RANGE[1], 2).map(value => ({ value, label: value % 4 === 0 ? (value > 0 ? `+${value}` : String(value)) : undefined }));
const codeTicks = [{ value: 0, label: "0" }, { value: 0.25 }, { value: 0.5, label: "0.5" }, { value: 0.75 }, { value: 1, label: "1" }];
const DIFFUSE_WHITE_STOPS = Math.log2(1 / 0.18);
const CURVE_STAGE_SECONDS = 2.6;
const FILM_SWEEP_SECONDS = 10;

function drawCurveSet(size: Size, seconds: number, curves: Curve[], display: (value: number) => number, yLabel: string, note: (curve: Curve) => string) {
  const frame = plotFrame(size);
  // Headroom above 1.0 keeps the readout clear of every curve that clips there.
  const scale = scaled(frame, STOPS_RANGE, [0, 1.22]);
  axes(size, frame, scale, stopTicks, codeTicks, "相对 18% 灰的档位", yLabel);
  for (const [stops, label] of [[0, "18%"], [DIFFUSE_WHITE_STOPS, "白 1.0"]] as const) {
    const x = scale.x(stops);
    stroke(size, [[x, frame.top + 30], [x, frame.top + frame.height]], ink(0.3), 1, [2, 3]);
    text(size, label, x + 3, frame.top + frame.height - 8, { alpha: 0.5 });
  }
  const { index } = cycle(seconds, CURVE_STAGE_SECONDS, curves.length);
  const samples = range(STOPS_RANGE[0], STOPS_RANGE[1], 0.1);
  const points = (shown: Curve) => samples.map((stops): Pixel => [scale.x(stops), scale.y(display(shown.encode(stopsToLinear(stops))))]);
  curves.forEach((shown, at) => { if (at !== index) stroke(size, points(shown), cssRgb(shown.color, 0.28), 1); });
  const shown = curves[index];
  stroke(size, points(shown), cssRgb(shown.color, 1), 2);
  dot(size, [scale.x(0), scale.y(display(shown.encode(0.18)))], 3, cssRgb(shown.color, 1));
  readout(size, frame, [shown.label, note(shown)], cssRgb(shown.color, 1));
}

function drawFilm(size: Size, seconds: number) {
  const frame = plotFrame(size);
  const scale = scaled(frame, FILM.range, [0, 2]);
  axes(size, frame, scale, range(-2.5, 1.5, 0.5).map(value => ({ value, label: Number.isInteger(value) ? String(value) : undefined })),
    range(0, 2, 0.5).map(value => ({ value, label: value.toFixed(1) })), "log₁₀ H（0 = 灰卡）", "密度 D");
  const samples = range(FILM.range[0], FILM.range[1], 0.02);
  stroke(size, samples.map((value): Pixel => [scale.x(value), scale.y(filmDensity(value))]), ink(0.9), 1.8);
  // On a rising curve, the space up and to the left stays clear.
  const marks: [number, string, CanvasTextAlign][] = [
    [FILM.range[0] + 0.15, "片基 + 灰雾", "left"], [FILM.toe + 0.1, "趾部", "right"],
    [-0.35, `直线部 γ ≈ ${FILM.gamma}`, "right"], [FILM.shoulder + 0.2, "肩部", "right"],
  ];
  for (const [value, label, align] of marks) {
    const [x, y] = [scale.x(value), scale.y(filmDensity(value))];
    text(size, label, align === "left" ? x : x - 8, y - 14, { align, alpha: 0.65 });
  }
  const exposure = lerp(FILM.range[0] + 0.2, FILM.range[1] - 0.2, sweep(seconds, FILM_SWEEP_SECONDS));
  const [x, y] = [scale.x(exposure), scale.y(filmDensity(exposure))];
  stroke(size, [[x, frame.top + frame.height], [x, y], [frame.left, y]], ink(0.5), 1, [2, 3]);
  dot(size, [x, y], 3.2, ink(1));
  readout(size, frame, [`D = ${filmDensity(exposure).toFixed(2)}`, "示意曲线，非任何具体胶片"]);
}

export function drawCurve(size: Size, view: CurveView, seconds: number) {
  if (view === "transfer") {
    drawCurveSet(size, seconds, TRANSFER_CURVES, value => value, "码值", shown => `18% → ${shown.encode(0.18).toFixed(3)}`);
  } else if (view === "tonemap") {
    drawCurveSet(size, seconds, TONE_CURVES, value => srgbEncode(value), "显示 sRGB 码值", shown => `18% → ${srgbEncode(shown.encode(0.18)).toFixed(3)}`);
  } else drawFilm(size, seconds);
}

export const CURVE_FRAMES = {
  transfer: cycleFrames(CURVE_STAGE_SECONDS, TRANSFER_CURVES.map(curve => curve.label)),
  tonemap: cycleFrames(CURVE_STAGE_SECONDS, TONE_CURVES.map(curve => curve.label)),
  film: sweepFrames(FILM_SWEEP_SECONDS, ["低曝光", "中段曝光", "高曝光"]),
};
