"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  CHROMATICITY_FRAMES,
  CURVE_FRAMES,
  SPECTRUM_FRAMES,
  drawChromaticity,
  drawCurve,
  drawSpectrum,
} from "@/lib/chart-drawing";
import { CHROMATICITY_LABELS } from "@/lib/chromaticity";
import { TRANSFORM_LABELS, transformLattice, transformVolume } from "@/lib/color-transform";
import {
  COLOR_MODEL_LABELS,
  GAMUT_LABELS,
  REC709_MODELS,
  VOLUME_OVERLAY_LABELS,
  colorVolume,
  type ColorVolume,
  type WireSegment,
} from "@/lib/color-volume";
import { STILL_SECONDS, morph, morphFrames } from "@/lib/diagram-motion";
import { TURNABLE_DIAGRAMS, homeDrawing, randomDrawing, useHomeDiagram, type HomeDrawing } from "@/lib/home-diagram";
import { PIXEL_LABELS } from "@/lib/pixel-demos";
import { PIXEL_FRAMES, drawPixel } from "@/lib/pixel-drawing";
import { drawVectorscope, drawWaveform, ink, labelled, type Size } from "@/lib/scope-drawing";
import {
  SCOPE_SIGNAL_LABELS,
  VECTOR_STYLE_LABELS,
  WAVE_STYLE_LABELS,
} from "@/lib/scope-signal";
import { SPECTRUM_LABELS } from "@/lib/spectrum-views";
import { CURVE_LABELS } from "@/lib/transfer-curves";

const MAX_PIXEL_RATIO = 2;
// The longest centered axis label plus its offset needs this much room beyond the wire.
const VOLUME_PADDING = 34;
// Slow enough to read as a turning object, and light on a modest machine.
const FRAME_MS = 50;
const TURN_PER_SECOND = Math.PI * 2 / 90;
const START_TURN = 0.6;
const START_TILT = 0.36;
const MAX_TILT = 1.45;
const DRAG_RADIANS_PER_PIXEL = 0.008;
// A flick past this would step too far between frames to read as turning.
const MAX_SPIN = 6;
// How long a flick takes to ease back to the resting turn.
const SETTLE_SECONDS = 1.1;

type Project = (point: readonly [number, number, number]) => readonly [number, number, number];
type Pair = readonly [number, number];
/** Alpha as base + nearness × gain, for edges and for the grid between them, and their line widths. */
type Weight = { edge: Pair; grid: Pair; width: Pair };

const REFERENCE_WEIGHT: Weight = { edge: [0.12, 0.16], grid: [0.08, 0.1], width: [1, 0.7] };
const SOLID_WEIGHT: Weight = { edge: [0.5, 0.5], grid: [0.2, 0.34], width: [1.2, 0.7] };
// An overlay reads as the subject, so the solid steps back behind it.
const UNDERLAID_WEIGHT: Weight = { edge: [0.25, 0.3], grid: [0.08, 0.14], width: [1.2, 0.7] };
const OVERLAY_WEIGHT: Weight = { edge: [0.6, 0.4], grid: [0.35, 0.4], width: [1.6, 0.9] };

function drawWire({ context }: Size, segments: WireSegment[], project: Project, weight: Weight) {
  for (const segment of segments) {
    const [fromX, fromY, fromDepth] = project(segment.from);
    const [toX, toY, toDepth] = project(segment.to);
    const nearness = ((fromDepth + toDepth) / 2 + 1.4) / 2.8;
    const [base, gain] = segment.edge ? weight.edge : weight.grid;
    const [r, g, b] = segment.color.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255));
    context.strokeStyle = `rgb(${r} ${g} ${b} / ${base + nearness * gain})`;
    context.lineWidth = segment.edge ? weight.width[0] : weight.width[1];
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
  }
}

/** A sphere around the rotation centre bounds every orthographic view of the drawing. */
function volumeRadius(volume: ColorVolume) {
  let radius = 0;
  for (const lines of [volume.segments, volume.reference, volume.overlay, volume.axes]) {
    for (const { from, to } of lines ?? []) radius = Math.max(radius, Math.hypot(...from), Math.hypot(...to));
  }
  for (const mark of volume.marks ?? []) radius = Math.max(radius, Math.hypot(...mark.at));
  return radius;
}

function drawVolume(size: Size, volume: ColorVolume, radius: number, turn: number, tilt: number) {
  const { context, side } = size;
  const center = side / 2;
  const scale = Math.min(side * 0.37, Math.max(0, center - VOLUME_PADDING) / radius);
  const cos = Math.cos(turn), sin = Math.sin(turn);
  const tiltCos = Math.cos(tilt), tiltSin = Math.sin(tilt);
  // Seen from above at a positive tilt: nearer points sit lower on the screen.
  const project: Project = ([x, y, z]) => {
    const across = x * cos - y * sin;
    const toward = x * sin + y * cos;
    return [center + across * scale, center - (z * tiltCos - toward * tiltSin) * scale, toward * tiltCos + z * tiltSin] as const;
  };

  context.lineCap = "round";
  context.strokeStyle = ink(0.34);
  context.lineWidth = 1;
  context.beginPath();
  for (const axis of volume.axes) {
    const [fromX, fromY] = project(axis.from);
    const [toX, toY] = project(axis.to);
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
  }
  context.stroke();

  if (volume.reference) drawWire(size, volume.reference, project, REFERENCE_WEIGHT);
  drawWire(size, volume.segments, project, volume.overlay ? UNDERLAID_WEIGHT : SOLID_WEIGHT);
  if (volume.overlay) drawWire(size, volume.overlay, project, OVERLAY_WEIGHT);

  // Labels go on last, so the wire never runs through a reading.
  for (const axis of volume.axes) {
    const [fromX, fromY] = project(axis.from);
    const [toX, toY] = project(axis.to);
    const length = Math.hypot(toX - fromX, toY - fromY) || 1;
    labelled(size, axis.label, toX + (toX - fromX) / length * 12, toY + (toY - fromY) / length * 12, 0.85);
    for (const tick of axis.ticks) {
      const [x, y] = project(tick.at);
      context.fillStyle = ink(0.6);
      context.fillRect(x - 1.5, y - 1.5, 3, 3);
      labelled(size, tick.label, x + (toY - fromY) / length * 15, y - (toX - fromX) / length * 15, 0.5);
    }
  }
  for (const mark of volume.marks ?? []) {
    const [x, y] = project(mark.at);
    labelled(size, mark.label, x, y - 10, 0.9);
  }
}

function caption(drawing: HomeDrawing) {
  const { diagram, gamut, model, signal, vectorStyle, waveStyle, overlay } = drawing;
  if (diagram === "volume") {
    const notes = [
      model === "xyy" ? "白色 Y=1" : "",
      REC709_MODELS.includes(model) ? "Rec.709 R′G′B′" : "",
      VOLUME_OVERLAY_LABELS[overlay],
    ].filter(Boolean);
    return [`${GAMUT_LABELS[gamut]} · ${COLOR_MODEL_LABELS[model]}`, ...notes].join(" · ");
  }
  if (diagram === "transform") return TRANSFORM_LABELS[drawing.transform];
  if (diagram === "chromaticity") return CHROMATICITY_LABELS[drawing.chromaticity];
  if (diagram === "spectrum") return SPECTRUM_LABELS[drawing.spectrum];
  if (diagram === "curve") return CURVE_LABELS[drawing.curve];
  if (diagram === "pixel") return PIXEL_LABELS[drawing.pixel];
  const style = diagram === "waveform" ? `波形 · ${WAVE_STYLE_LABELS[waveStyle]}` : `矢量图 · ${VECTOR_STYLE_LABELS[vectorStyle]}`;
  return `${style} · ${SCOPE_SIGNAL_LABELS[signal]} · Rec.709`;
}

const transformFrames = morphFrames("输入", "输出");

function diagramFrames(drawing: HomeDrawing) {
  if (drawing.diagram === "transform") return transformFrames;
  if (drawing.diagram === "chromaticity") return CHROMATICITY_FRAMES[drawing.chromaticity];
  if (drawing.diagram === "spectrum") return SPECTRUM_FRAMES[drawing.spectrum];
  if (drawing.diagram === "curve") return CURVE_FRAMES[drawing.curve];
  if (drawing.diagram === "pixel") return PIXEL_FRAMES[drawing.pixel];
  return null;
}

export function HomeDiagram() {
  const settings = useHomeDiagram();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stillRef = useRef<{ seconds: number; redraw?: () => void }>({ seconds: STILL_SECONDS });
  const captionId = useId();
  const frameId = useId();
  // Outlives a change of gamut or model, so the solid stays where it was left.
  const viewRef = useRef({ turn: START_TURN, tilt: START_TILT });
  // Chosen once per visit; the server never renders the diagram, so it cannot disagree.
  const [chance] = useState(() => randomDrawing());
  const [manual, setManual] = useState<{ key: string; index: number } | null>(null);
  const drawing = settings && homeDrawing(settings, chance);
  // The serialized drawing keeps the painter stable while the manual stage changes.
  const key = drawing ? JSON.stringify(drawing) : "";
  const pinned = settings !== null && settings.diagram !== "random";
  const frames = drawing && pinned ? diagramFrames(drawing) : null;
  const frameIndex = manual?.key === key ? manual.index : 0;
  const selectedFrame = frames?.[frameIndex];
  const stillSeconds = selectedFrame?.seconds ?? STILL_SECONDS;

  useEffect(() => {
    stillRef.current.seconds = stillSeconds;
    stillRef.current.redraw?.();
  }, [stillSeconds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !key) return;
    const shown = JSON.parse(key) as HomeDrawing;
    const { diagram } = shown;
    const surface = canvas;
    const turnable = TURNABLE_DIAGRAMS.includes(diagram);
    const timed = diagramFrames(shown) !== null;
    const volume = diagram === "volume" ? colorVolume(shown.gamut, shown.model, shown.overlay) : null;
    const lattice = diagram === "transform" ? transformLattice(shown.transform) : null;
    let radius = volume ? volumeRadius(volume) : 1;
    if (lattice) {
      // Each vertex travels on a straight line, so the endpoints bound the whole morph.
      radius = Math.max(volumeRadius(transformVolume(lattice, 0)), volumeRadius(transformVolume(lattice, 1)));
    }
    const view = viewRef.current;
    const still = stillRef.current;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const began = performance.now();
    let frame = 0;
    let lastPaint = 0;
    let spin = TURN_PER_SECOND;
    let held: { pointer: number; x: number; y: number; at: number } | null = null;

    function paint() {
      const side = surface.clientWidth;
      if (!side || !context) return;
      const ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const pixels = Math.round(side * ratio);
      if (surface.width !== pixels || surface.height !== pixels) surface.width = surface.height = pixels;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, side, side);
      const size = { context, side };
      const seconds = motion.matches ? still.seconds : (performance.now() - began) / 1000;
      if (diagram === "vectorscope") drawVectorscope(size, shown.signal, shown.vectorStyle, shown.phosphor, shown.seed);
      else if (diagram === "waveform") drawWaveform(size, shown.signal, shown.waveStyle, shown.phosphor, shown.seed);
      else if (volume) drawVolume(size, volume, radius, view.turn, view.tilt);
      else if (lattice) drawVolume(size, transformVolume(lattice, morph(seconds)), radius, view.turn, view.tilt);
      else if (diagram === "chromaticity") drawChromaticity(size, shown.chromaticity, seconds);
      else if (diagram === "spectrum") drawSpectrum(size, shown.spectrum, seconds);
      else if (diagram === "curve") drawCurve(size, shown.curve, seconds);
      else if (diagram === "pixel") drawPixel(size, shown.pixel, seconds);
    }

    function tick(now: number) {
      frame = requestAnimationFrame(tick);
      // Under the hand or coasting it follows every frame; left alone it can idle.
      const coasting = Math.abs(spin - TURN_PER_SECOND) > 0.05;
      if (!held && !coasting && now - lastPaint < FRAME_MS) return;
      const seconds = Math.min(0.1, (now - lastPaint) / 1000);
      lastPaint = now;
      if (!held && turnable) {
        spin += (TURN_PER_SECOND - spin) * (1 - Math.exp(-seconds / SETTLE_SECONDS));
        view.turn += spin * seconds;
      }
      paint();
    }

    function start() {
      cancelAnimationFrame(frame);
      paint();
      lastPaint = performance.now();
      if ((turnable || timed) && !motion.matches) frame = requestAnimationFrame(tick);
    }

    function grab(event: PointerEvent) {
      if (!turnable || event.button !== 0) return;
      surface.setPointerCapture(event.pointerId);
      held = { pointer: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp };
    }

    function drag(event: PointerEvent) {
      if (held?.pointer !== event.pointerId) return;
      const across = (event.clientX - held.x) * DRAG_RADIANS_PER_PIXEL;
      const seconds = Math.max(0.001, (event.timeStamp - held.at) / 1000);
      // Dragging right carries the near face right, which is a negative turn.
      view.turn -= across;
      view.tilt = Math.min(MAX_TILT, Math.max(-MAX_TILT, view.tilt + (event.clientY - held.y) * DRAG_RADIANS_PER_PIXEL));
      spin = Math.min(MAX_SPIN, Math.max(-MAX_SPIN, -across / seconds));
      held = { ...held, x: event.clientX, y: event.clientY, at: event.timeStamp };
      if (motion.matches) paint();
    }

    function release(event: PointerEvent) {
      if (held?.pointer !== event.pointerId) return;
      // A hand that stopped before letting go has not thrown anything.
      if (event.timeStamp - held.at > 80 || motion.matches) spin = TURN_PER_SECOND;
      held = null;
    }

    const observer = new ResizeObserver(paint);
    observer.observe(surface);
    still.redraw = () => { if (motion.matches) paint(); };
    motion.addEventListener("change", start);
    surface.addEventListener("pointerdown", grab);
    surface.addEventListener("pointermove", drag);
    surface.addEventListener("pointerup", release);
    surface.addEventListener("pointercancel", release);
    start();
    return () => {
      still.redraw = undefined;
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener("change", start);
      surface.removeEventListener("pointerdown", grab);
      surface.removeEventListener("pointermove", drag);
      surface.removeEventListener("pointerup", release);
      surface.removeEventListener("pointercancel", release);
    };
  }, [key]);

  if (!drawing) return null;
  return (
    <figure
      className="home-diagram"
      aria-hidden={pinned ? undefined : true}
      aria-labelledby={pinned ? captionId : undefined}
      data-diagram={drawing.diagram}
      data-draggable={TURNABLE_DIAGRAMS.includes(drawing.diagram) ? "" : undefined}
      data-pinned={pinned ? "" : undefined}
    >
      <figcaption id={captionId}>{caption(drawing)}</figcaption>
      <canvas ref={canvasRef} aria-hidden="true" />
      {frames && selectedFrame ? (
        <div className="home-diagram-frames">
          <label htmlFor={frameId}>图示阶段</label>
          <span aria-hidden="true">{selectedFrame.label}</span>
          <input
            id={frameId}
            type="range"
            min={0}
            max={frames.length - 1}
            value={frameIndex}
            aria-valuetext={selectedFrame.label}
            onChange={event => setManual({ key, index: event.currentTarget.valueAsNumber })}
          />
        </div>
      ) : null}
    </figure>
  );
}
