import {
  colorBars,
  scanLine,
  type Phosphor,
  type ScopeSample,
  type ScopeSignal,
  type VectorStyle,
  type WaveStyle,
} from "./scope-signal";

export type Size = { context: CanvasRenderingContext2D; side: number };

const INK = "226 232 238";
const FONT = '10px "JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace';
const PHOSPHOR_RGB: Record<Exclude<Phosphor, "signal">, string> = { white: INK, green: "116 255 150", amber: "255 190 96" };
// The classic skin-tone line, degrees from the +Cb axis.
const SKIN_TONE_ANGLE = 123;
const TRACE_ALPHA = 0.5;

export function ink(alpha: number) {
  return `rgb(${INK} / ${alpha})`;
}

export function labelled({ context }: Size, text: string, x: number, y: number, alpha = 0.55) {
  context.font = FONT;
  context.fillStyle = ink(alpha);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, x, y);
}

// Deterministic per visit, so the phosphor grain does not shimmer between redraws.
function grain(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

// Lifted, or the dark end of a signal's own colour would vanish against black.
function signalInk([r, g, b]: readonly number[]) {
  return `rgb(${[r, g, b].map(value => Math.round(value * 200 + 55)).join(" ")} / ${TRACE_ALPHA})`;
}

function phosphorInk(phosphor: Phosphor, sample: ScopeSample, channel?: readonly number[]) {
  if (phosphor === "signal") return signalInk(channel ?? sample.rgb);
  return `rgb(${PHOSPHOR_RGB[phosphor]} / ${TRACE_ALPHA})`;
}

export function drawVectorscope(size: Size, signal: ScopeSignal, style: VectorStyle, phosphor: Phosphor, seed: number) {
  const { context, side } = size;
  const center = side / 2;
  const radius = side * 0.42;
  const zoom = style === "zoom" ? 2 : 1;
  const place = (cb: number, cr: number) => [center + cb * 2 * radius * zoom, center - cr * 2 * radius * zoom] as const;

  context.strokeStyle = ink(0.34);
  context.lineWidth = 1;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.moveTo(center - radius, center);
  context.lineTo(center + radius, center);
  context.moveTo(center, center - radius);
  context.lineTo(center, center + radius);
  for (let degree = 0; degree < 360; degree += 10) {
    const angle = degree * Math.PI / 180;
    const inner = radius * (degree % 30 ? 0.975 : 0.95);
    context.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
    context.lineTo(center + Math.cos(angle) * radius, center + Math.sin(angle) * radius);
  }
  context.stroke();

  const skin = SKIN_TONE_ANGLE * Math.PI / 180;
  context.strokeStyle = ink(0.2);
  context.beginPath();
  context.moveTo(center, center);
  context.lineTo(center + Math.cos(skin) * radius, center - Math.sin(skin) * radius);
  context.stroke();

  // Magnifying pushes the outer targets past the graticule, as it does on a real scope.
  context.save();
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  if (zoom > 1) context.clip();
  const targets = (level: number, box: number) => {
    for (const bar of colorBars(level).filter(({ cb, cr }) => cb !== 0 || cr !== 0)) {
      const [x, y] = place(bar.cb, bar.cr);
      context.strokeStyle = ink(0.42);
      context.strokeRect(x - box, y - box, box * 2, box * 2);
    }
  };
  targets(0.75, side * 0.02);
  targets(1, side * 0.008);

  const line = scanLine(signal);
  const random = grain(seed);
  context.globalCompositeOperation = "lighter";
  if (style === "points") {
    for (let index = 0; index < line.length; index += 8) {
      const [x, y] = place(line[index].cb, line[index].cr);
      context.fillStyle = phosphorInk(phosphor, line[index]);
      context.fillRect(x + random() * 2.4 - 1, y + random() * 2.4 - 1, 2, 2);
    }
  } else {
    // The trace is walked, so a fast change between patches still reads as a line.
    line.forEach((sample, index) => {
      const next = line[(index + 1) % line.length];
      const [fromX, fromY] = place(sample.cb, sample.cr);
      const [toX, toY] = place(next.cb, next.cr);
      const steps = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toY - fromY)));
      context.fillStyle = phosphorInk(phosphor, sample);
      for (let step = 0; step < steps; step++) {
        const along = step / steps;
        context.fillRect(fromX + (toX - fromX) * along + random() * 2, fromY + (toY - fromY) * along + random() * 2, 1, 1);
      }
    });
  }
  context.globalCompositeOperation = "source-over";
  context.restore();

  if (zoom > 1) labelled(size, "×2", center + radius * 0.82, center - radius * 0.82);
  else for (const bar of colorBars(0.75).filter(({ cb, cr }) => cb !== 0 || cr !== 0)) {
    const [x, y] = place(bar.cb, bar.cr);
    labelled(size, bar.label, center + (x - center) * 1.26, center + (y - center) * 1.26);
  }
}

type Channel = { label?: string; value: (sample: ScopeSample) => number; color?: readonly number[] };

const LUMA: Channel = { label: "Y", value: sample => sample.luma };
const RED: Channel = { label: "R", value: sample => sample.rgb[0], color: [1, 0.2, 0.2] };
const GREEN: Channel = { label: "G", value: sample => sample.rgb[1], color: [0.2, 1, 0.3] };
const BLUE: Channel = { label: "B", value: sample => sample.rgb[2], color: [0.3, 0.45, 1] };

const WAVE_PANELS: Record<WaveStyle, Channel[][]> = {
  luma: [[{ value: LUMA.value }]],
  rgb: [[RED], [GREEN], [BLUE]],
  // Colour difference sits around mid-scale, as a component waveform draws it.
  ycbcr: [[LUMA], [{ ...BLUE, label: "Cb", value: sample => sample.cb + 0.5 }], [{ ...RED, label: "Cr", value: sample => sample.cr + 0.5 }]],
  overlay: [[{ ...RED, label: undefined }, { ...GREEN, label: undefined }, { ...BLUE, label: undefined }]],
};

export function drawWaveform(size: Size, signal: ScopeSignal, style: WaveStyle, phosphor: Phosphor, seed: number) {
  const { context, side } = size;
  const left = side * 0.1, right = side * 0.96;
  const top = side * 0.2, bottom = side * 0.8;
  const level = (value: number) => bottom - (bottom - top) * value;

  context.lineWidth = 1;
  for (let line = 0; line <= 10; line++) {
    const y = Math.round(level(line / 10)) + 0.5;
    context.strokeStyle = ink(line % 5 ? 0.14 : 0.32);
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    if (line % 2 === 0) labelled(size, String(line * 10), left - side * 0.05, y);
  }

  const panels = WAVE_PANELS[style];
  const panelWidth = (right - left) / panels.length;
  const gutter = panels.length > 1 ? side * 0.012 : 0;
  const line = scanLine(signal);
  const random = grain(seed);
  panels.forEach((channels, panel) => {
    const start = left + panelWidth * panel + gutter;
    const width = panelWidth - gutter * 2;
    const label = channels[0].label;
    if (label) labelled(size, label, start + width / 2, top - side * 0.03, 0.7);
    context.globalCompositeOperation = "lighter";
    for (const channel of channels) {
      const at = (x: number) => line[Math.min(line.length - 1, Math.floor(x / width * line.length))];
      let previous = level(channel.value(at(0)));
      for (let x = 0; x < width; x++) {
        const sample = at(x);
        const y = level(channel.value(sample));
        // Steep edges have to be walked, or a fall between bars leaves a dotted gap.
        const dots = 6 + Math.ceil(Math.abs(y - previous) * 2);
        context.fillStyle = phosphorInk(phosphor, sample, channel.color);
        for (let dot = 0; dot < dots; dot++) {
          context.fillRect(start + x, previous + (y - previous) * dot / dots + random() * 3.2, 1, 1);
        }
        previous = y;
      }
    }
    context.globalCompositeOperation = "source-over";
  });
}
