/** Canvas drawing for the pixel diagrams: blocks of real pixels, enlarged. */

import { stroke, text, type Frame } from "./chart-drawing";
import { cssRgb, lerpVector, mapVector, srgbEncode, type Vector } from "./color-math";
import { cycle, cycleFrames, sweep, sweepFrames } from "./diagram-motion";
import {
  BIT_DEPTHS,
  BIT_DEPTH_WINDOW,
  BLUE_PIGMENT,
  PATCH_HEIGHT,
  PATCH_WIDTH,
  SUBSAMPLING_MODES,
  YELLOW_PIGMENT,
  bayerChannel,
  demosaic,
  lightMix,
  mosaic,
  pigmentMix,
  quantise,
  reflectanceColor,
  subsample,
  testPatch,
  type Image,
  type PixelView,
} from "./pixel-demos";
import { ink, type Size } from "./scope-drawing";
import { WAVELENGTHS } from "./spectral";

const PATCH = testPatch();
const SUBSAMPLING_STAGE_SECONDS = 3;
const BAYER_STAGE_SECONDS = 3.2;
const PIXEL_SWEEP_SECONDS = 10;

function patchFrame({ side }: Size) {
  const cell = Math.floor(side * 0.8 / PATCH_WIDTH);
  const width = cell * PATCH_WIDTH, height = cell * PATCH_HEIGHT;
  return { cell, left: Math.round((side - width) / 2), top: Math.round((side - height) / 2) };
}

function drawImage({ context }: Size, image: Image, frame: ReturnType<typeof patchFrame>, alpha = 1) {
  image.forEach((row, y) => row.forEach((pixel, x) => {
    context.fillStyle = cssRgb(pixel, alpha);
    context.fillRect(frame.left + x * frame.cell, frame.top + y * frame.cell, frame.cell, frame.cell);
  }));
}

function grid(size: Size, frame: ReturnType<typeof patchFrame>, across: number, down: number, style: string) {
  for (let x = 0; x <= PATCH_WIDTH; x += across) {
    const at = frame.left + x * frame.cell + 0.5;
    stroke(size, [[at, frame.top], [at, frame.top + PATCH_HEIGHT * frame.cell]], style);
  }
  for (let y = 0; y <= PATCH_HEIGHT; y += down) {
    const at = frame.top + y * frame.cell + 0.5;
    stroke(size, [[frame.left, at], [frame.left + PATCH_WIDTH * frame.cell, at]], style);
  }
}

function heading(size: Size, frame: ReturnType<typeof patchFrame>, title: string, note: string) {
  text(size, title, frame.left, frame.top - 26, { alpha: 0.9, size: 13 });
  text(size, note, frame.left, frame.top - 10, { alpha: 0.5 });
}

function drawSubsampling(size: Size, seconds: number) {
  const frame = patchFrame(size);
  const { index } = cycle(seconds, SUBSAMPLING_STAGE_SECONDS, SUBSAMPLING_MODES.length);
  const mode = SUBSAMPLING_MODES[index];
  const { image, chromaSamples } = subsample(PATCH, mode);
  drawImage(size, image, frame);
  grid(size, frame, 1, 1, ink(0.08));
  grid(size, frame, mode === "4:4:4" ? 1 : 2, mode === "4:2:0" ? 2 : 1, ink(0.4));
  const { context } = size;
  for (const sample of chromaSamples) {
    const x = frame.left + sample.x * frame.cell, y = frame.top + sample.y * frame.cell;
    context.strokeStyle = "rgb(0 0 0 / 0.7)";
    context.fillStyle = ink(0.9);
    context.beginPath();
    context.arc(x, y, Math.max(1.5, frame.cell * 0.12), 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  const share = { "4:4:4": "每个像素一份色度", "4:2:2": "横向两像素共用色度", "4:2:0": "2×2 像素共用色度" }[mode];
  heading(size, frame, mode, `${share} · Y′ 始终逐像素保留`);
}

function drawBitDepth(size: Size, seconds: number) {
  const { context, side } = size;
  const left = side * 0.2, width = side * 0.72;
  const strip = side * 0.12, gap = side * 0.06;
  const top = (side - BIT_DEPTHS.length * strip - (BIT_DEPTHS.length - 1) * gap) / 2;
  const cursor = sweep(seconds, PIXEL_SWEEP_SECONDS);
  const columns = Math.round(width);
  BIT_DEPTHS.forEach((bits, row) => {
    const y = top + row * (strip + gap);
    for (let column = 0; column < columns; column++) {
      const value = quantise(column / (columns - 1) * BIT_DEPTH_WINDOW, bits) / BIT_DEPTH_WINDOW;
      context.fillStyle = cssRgb([value, value, value]);
      context.fillRect(left + column, y, 1.5, strip);
    }
    const levels = Math.round(BIT_DEPTH_WINDOW * (2 ** bits - 1)) + 1;
    text(size, `${bits}-bit`, left - 8, y + strip / 2 - 6, { align: "right", alpha: 0.85 });
    text(size, `${levels} 级`, left - 8, y + strip / 2 + 7, { align: "right", alpha: 0.45 });
    const code = Math.round(cursor * BIT_DEPTH_WINDOW * (2 ** bits - 1));
    text(size, `码值 ${code}`, left + cursor * width, y + strip + 10, { align: cursor > 0.8 ? "right" : "left", alpha: 0.6 });
  });
  const x = left + cursor * width;
  stroke(size, [[x, top - 6], [x, top + BIT_DEPTHS.length * (strip + gap) - gap + 6]], ink(0.7), 1);
  text(size, "同一段 0–8% 暗部渐变，放大到满屏", left, top - 20, { alpha: 0.55 });
}

const BAYER_STAGES = ["原始画面", "RGGB 马赛克", "双线性去马赛克"] as const;

function bayerStage(stage: number): Image {
  if (stage === 0) return PATCH;
  const sites = mosaic(PATCH);
  if (stage === 2) return demosaic(sites);
  return sites.map((row, y) => row.map((value, x) =>
    mapVector([0, 0, 0], (_, channel) => (channel === bayerChannel(x, y) ? srgbEncode(value) : 0))));
}

const BAYER_IMAGES = [0, 1, 2].map(bayerStage);

function drawBayer(size: Size, seconds: number) {
  const frame = patchFrame(size);
  const { index, next, blend } = cycle(seconds, BAYER_STAGE_SECONDS, BAYER_STAGES.length, 0.6);
  const image = BAYER_IMAGES[index].map((row, y) => row.map((pixel, x) => lerpVector(pixel, BAYER_IMAGES[next][y][x], blend)));
  drawImage(size, image, frame);
  grid(size, frame, 1, 1, ink(index === 1 ? 0.2 : 0.06));
  const stage = blend > 0.5 ? next : index;
  const note = ["每个像素有完整 RGB", "每个感光点只记一个通道，绿色占一半", "缺失的通道由邻居插值，细纹出现伪色"][stage];
  heading(size, frame, BAYER_STAGES[stage], note);
}

function drawMixing(size: Size, seconds: number) {
  const { context, side } = size;
  const left = side * 0.13, width = side * 0.8;
  const strip = side * 0.08;
  const yellow = sweep(seconds, PIXEL_SWEEP_SECONDS);
  const rows: [string, (share: number) => Vector][] = [
    ["光：加色", lightMix],
    ["颜料：Kubelka–Munk", share => reflectanceColor(pigmentMix(share))],
  ];
  rows.forEach(([label, color], row) => {
    const y = side * 0.1 + row * (strip + side * 0.07);
    text(size, label, left, y - 8, { alpha: 0.7 });
    for (let column = 0; column < width; column += 2) {
      context.fillStyle = cssRgb(color(column / width));
      context.fillRect(left + column, y, 2.5, strip);
    }
    const x = left + yellow * width;
    stroke(size, [[x, y - 2], [x, y + strip + 2]], ink(0.95), 1.4);
  });
  text(size, "蓝", left, side * 0.1 + 2 * (strip + side * 0.07) - side * 0.045, { alpha: 0.5 });
  text(size, "黄", left + width, side * 0.1 + 2 * (strip + side * 0.07) - side * 0.045, { align: "right", alpha: 0.5 });

  const plot: Frame = { left, top: side * 0.5, width, height: side * 0.36 };
  const x = (wavelength: number) => plot.left + (wavelength - WAVELENGTHS[0]) / (WAVELENGTHS[WAVELENGTHS.length - 1] - WAVELENGTHS[0]) * plot.width;
  const y = (value: number) => plot.top + plot.height * (1 - value);
  stroke(size, [[plot.left, plot.top], [plot.left, plot.top + plot.height], [plot.left + plot.width, plot.top + plot.height]], ink(0.34));
  const line = (values: readonly number[]) => values.map((value, index) => [x(WAVELENGTHS[index]), y(value)] as const);
  stroke(size, line(BLUE_PIGMENT), cssRgb(reflectanceColor(BLUE_PIGMENT), 0.9), 1.2, [4, 3]);
  stroke(size, line(YELLOW_PIGMENT), cssRgb(reflectanceColor(YELLOW_PIGMENT), 0.9), 1.2, [4, 3]);
  const mix = pigmentMix(yellow);
  stroke(size, line(mix), cssRgb(reflectanceColor(mix), 1), 2);
  text(size, "反射率 · 虚线为两种理想化颜料", plot.left, plot.top - 10, { alpha: 0.55 });
  for (const wavelength of [400, 500, 600, 700]) text(size, String(wavelength), x(wavelength), plot.top + plot.height + 11, { align: "center", alpha: 0.5 });
  text(size, `黄 ${Math.round(yellow * 100)}%`, plot.left + plot.width, plot.top - 10, { align: "right", alpha: 0.85 });
}

export function drawPixel(size: Size, view: PixelView, seconds: number) {
  if (view === "subsampling") drawSubsampling(size, seconds);
  else if (view === "bitdepth") drawBitDepth(size, seconds);
  else if (view === "bayer") drawBayer(size, seconds);
  else drawMixing(size, seconds);
}

export const PIXEL_FRAMES = {
  subsampling: cycleFrames(SUBSAMPLING_STAGE_SECONDS, SUBSAMPLING_MODES),
  bitdepth: sweepFrames(PIXEL_SWEEP_SECONDS, ["0%", "4%", "8%"]),
  bayer: cycleFrames(BAYER_STAGE_SECONDS, BAYER_STAGES),
  mixing: sweepFrames(PIXEL_SWEEP_SECONDS, ["纯蓝", "50% 黄", "纯黄"]),
};
