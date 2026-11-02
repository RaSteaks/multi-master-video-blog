"use client";

import { useEffect, useRef, useState } from "react";
import {
  COLOR_MODEL_LABELS,
  GAMUT_LABELS,
  colorVolume,
  type ColorVolume,
} from "@/lib/color-volume";
import { homeDrawing, randomDrawing, useHomeDiagram, type HomeDrawing } from "@/lib/home-diagram";
import { drawVectorscope, drawWaveform, ink, labelled, type Size } from "@/lib/scope-drawing";
import {
  SCOPE_SIGNAL_LABELS,
  VECTOR_STYLE_LABELS,
  WAVE_STYLE_LABELS,
  type Phosphor,
  type ScopeSignal,
  type VectorStyle,
  type WaveStyle,
} from "@/lib/scope-signal";

const MAX_PIXEL_RATIO = 2;
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

function drawVolume(size: Size, volume: ColorVolume, turn: number, tilt: number) {
  const { context, side } = size;
  const center = side / 2;
  const scale = side * 0.37;
  const cos = Math.cos(turn), sin = Math.sin(turn);
  const tiltCos = Math.cos(tilt), tiltSin = Math.sin(tilt);
  // Seen from above at a positive tilt: nearer points sit lower on the screen.
  const project = ([x, y, z]: readonly [number, number, number]) => {
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

  for (const segment of volume.segments) {
    const [fromX, fromY, fromDepth] = project(segment.from);
    const [toX, toY, toDepth] = project(segment.to);
    const nearness = ((fromDepth + toDepth) / 2 + 1.4) / 2.8;
    const alpha = (segment.edge ? 0.5 : 0.2) + nearness * (segment.edge ? 0.5 : 0.34);
    const [r, g, b] = segment.color.map(value => Math.round(value * 255));
    context.strokeStyle = `rgb(${r} ${g} ${b} / ${alpha})`;
    context.lineWidth = segment.edge ? 1.2 : 0.7;
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
  }

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
}

function caption({ diagram, gamut, model, signal, vectorStyle, waveStyle }: HomeDrawing) {
  if (diagram === "volume") return `${GAMUT_LABELS[gamut]} · ${COLOR_MODEL_LABELS[model]}${model === "xyy" ? " · 白色 Y=1" : ""}`;
  const style = diagram === "waveform" ? `波形 · ${WAVE_STYLE_LABELS[waveStyle]}` : `矢量图 · ${VECTOR_STYLE_LABELS[vectorStyle]}`;
  return `${style} · ${SCOPE_SIGNAL_LABELS[signal]} · Rec.709`;
}

export function HomeDiagram() {
  const settings = useHomeDiagram();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Outlives a change of gamut or model, so the solid stays where it was left.
  const viewRef = useRef({ turn: START_TURN, tilt: START_TILT });
  // Chosen once per visit; the server never renders the diagram, so it cannot disagree.
  const [chance] = useState(() => randomDrawing());
  const drawing = settings && homeDrawing(settings, chance);
  const diagram = drawing?.diagram;
  const gamut = drawing?.gamut;
  const model = drawing?.model;
  const signal = drawing?.signal;
  const vectorStyle = drawing?.vectorStyle;
  const waveStyle = drawing?.waveStyle;
  const phosphor = drawing?.phosphor;
  const seed = chance.seed;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !diagram || !gamut || !model || !signal || !vectorStyle || !waveStyle || !phosphor) return;
    const surface = canvas;
    const volume = diagram === "volume" ? colorVolume(gamut, model) : null;
    const view = viewRef.current;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastPaint = 0;
    let spin = TURN_PER_SECOND;
    let held: { pointer: number; x: number; y: number; at: number } | null = null;

    function paint() {
      const side = surface.clientWidth;
      if (!side || !context) return;
      const ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const pixels = Math.round(side * ratio);
      if (surface.width !== pixels) surface.width = surface.height = pixels;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, side, side);
      const size = { context, side };
      if (diagram === "vectorscope") drawVectorscope(size, signal as ScopeSignal, vectorStyle as VectorStyle, phosphor as Phosphor, seed);
      else if (diagram === "waveform") drawWaveform(size, signal as ScopeSignal, waveStyle as WaveStyle, phosphor as Phosphor, seed);
      else if (volume) drawVolume(size, volume, view.turn, view.tilt);
    }

    function tick(now: number) {
      frame = requestAnimationFrame(tick);
      // Under the hand or coasting it follows every frame; left alone it can idle.
      const coasting = Math.abs(spin - TURN_PER_SECOND) > 0.05;
      if (!held && !coasting && now - lastPaint < FRAME_MS) return;
      const seconds = Math.min(0.1, (now - lastPaint) / 1000);
      lastPaint = now;
      if (!held) {
        spin += (TURN_PER_SECOND - spin) * (1 - Math.exp(-seconds / SETTLE_SECONDS));
        view.turn += spin * seconds;
      }
      paint();
    }

    function start() {
      cancelAnimationFrame(frame);
      paint();
      lastPaint = performance.now();
      if (diagram === "volume" && !motion.matches) frame = requestAnimationFrame(tick);
    }

    function grab(event: PointerEvent) {
      if (diagram !== "volume" || event.button !== 0) return;
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
    motion.addEventListener("change", start);
    surface.addEventListener("pointerdown", grab);
    surface.addEventListener("pointermove", drag);
    surface.addEventListener("pointerup", release);
    surface.addEventListener("pointercancel", release);
    start();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener("change", start);
      surface.removeEventListener("pointerdown", grab);
      surface.removeEventListener("pointermove", drag);
      surface.removeEventListener("pointerup", release);
      surface.removeEventListener("pointercancel", release);
    };
  }, [diagram, gamut, model, signal, vectorStyle, waveStyle, phosphor, seed]);

  if (!drawing) return null;
  return (
    <figure className="home-diagram" aria-hidden="true" data-draggable={drawing.diagram === "volume" ? "" : undefined}>
      <canvas ref={canvasRef} />
      <figcaption>{caption(drawing)}</figcaption>
    </figure>
  );
}
