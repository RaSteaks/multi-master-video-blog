import { useSyncExternalStore } from "react";
import { CHROMATICITY_VIEWS, type ChromaticityView } from "./chromaticity";
import { TRANSFORMS, type TransformId } from "./color-transform";
import { COLOR_MODELS, GAMUTS, VOLUME_OVERLAYS, type ColorModelId, type GamutId, type VolumeOverlay } from "./color-volume";
import { PIXEL_VIEWS, type PixelView } from "./pixel-demos";
import {
  PHOSPHORS,
  SCOPE_SIGNALS,
  VECTOR_STYLES,
  WAVE_STYLES,
  type Phosphor,
  type ScopeSignal,
  type VectorStyle,
  type WaveStyle,
} from "./scope-signal";
import { SPECTRUM_VIEWS, type SpectrumView } from "./spectrum-views";
import { CURVE_VIEWS, type CurveView } from "./transfer-curves";

const DRAWN_DIAGRAMS = ["vectorscope", "waveform", "volume", "transform", "chromaticity", "spectrum", "curve", "pixel"] as const;
export type DrawnDiagram = (typeof DRAWN_DIAGRAMS)[number];
export const HOME_DIAGRAMS = ["off", "random", ...DRAWN_DIAGRAMS] as const;
export type HomeDiagramKind = (typeof HOME_DIAGRAMS)[number];
/** Diagrams the hand can turn. */
export const TURNABLE_DIAGRAMS: readonly DrawnDiagram[] = ["volume", "transform"];

export const GAMUT_CHOICES = ["random", ...GAMUTS] as const;
export type GamutChoice = (typeof GAMUT_CHOICES)[number];
export const SIGNAL_CHOICES = ["random", ...SCOPE_SIGNALS] as const;
export const VECTOR_STYLE_CHOICES = ["random", ...VECTOR_STYLES] as const;
export const WAVE_STYLE_CHOICES = ["random", ...WAVE_STYLES] as const;
export const PHOSPHOR_CHOICES = ["random", ...PHOSPHORS] as const;
export const OVERLAY_CHOICES = ["random", ...VOLUME_OVERLAYS] as const;
export const TRANSFORM_CHOICES = ["random", ...TRANSFORMS] as const;
export const CHROMATICITY_CHOICES = ["random", ...CHROMATICITY_VIEWS] as const;
export const SPECTRUM_CHOICES = ["random", ...SPECTRUM_VIEWS] as const;
export const CURVE_CHOICES = ["random", ...CURVE_VIEWS] as const;
export const PIXEL_CHOICES = ["random", ...PIXEL_VIEWS] as const;

export type HomeDiagramPreferences = {
  version: 2;
  diagram: HomeDiagramKind;
  gamut: GamutChoice;
  model: ColorModelId;
  signal: (typeof SIGNAL_CHOICES)[number];
  vectorStyle: (typeof VECTOR_STYLE_CHOICES)[number];
  waveStyle: (typeof WAVE_STYLE_CHOICES)[number];
  phosphor: (typeof PHOSPHOR_CHOICES)[number];
  overlay: (typeof OVERLAY_CHOICES)[number];
  transform: (typeof TRANSFORM_CHOICES)[number];
  chromaticity: (typeof CHROMATICITY_CHOICES)[number];
  spectrum: (typeof SPECTRUM_CHOICES)[number];
  curve: (typeof CURVE_CHOICES)[number];
  pixel: (typeof PIXEL_CHOICES)[number];
};

export const HOME_DIAGRAM_STORAGE_KEY = "mm-home-diagram-v2";
const CHANGE_EVENT = "home-diagram-change";

export const DEFAULT_HOME_DIAGRAM: HomeDiagramPreferences = {
  version: 2, diagram: "random", gamut: "random", model: "xyz",
  signal: "random", vectorStyle: "random", waveStyle: "random", phosphor: "random",
  overlay: "none", transform: "random", chromaticity: "random", spectrum: "random", curve: "random", pixel: "random",
};

/** The gamut a visit shows when the choice is left to chance. */
export function randomGamut(random = Math.random): GamutId {
  return GAMUTS[Math.floor(random() * GAMUTS.length)];
}

/** One complete drawing. Each diagram is equally likely, so no one kind crowds out the rest. */
export type HomeDrawing = {
  diagram: DrawnDiagram;
  gamut: GamutId;
  model: ColorModelId;
  signal: ScopeSignal;
  vectorStyle: VectorStyle;
  waveStyle: WaveStyle;
  phosphor: Phosphor;
  overlay: VolumeOverlay;
  transform: TransformId;
  chromaticity: ChromaticityView;
  spectrum: SpectrumView;
  curve: CurveView;
  pixel: PixelView;
  seed: number;
};

// The bare solid stays as common as all the overlays together.
const OVERLAY_ODDS: readonly VolumeOverlay[] = [...VOLUME_OVERLAYS.filter(overlay => overlay !== "none").map(() => "none" as const), ...VOLUME_OVERLAYS.filter(overlay => overlay !== "none")];

export function randomDrawing(random = Math.random): HomeDrawing {
  const pick = <T,>(options: readonly T[]) => options[Math.floor(random() * options.length)];
  return {
    diagram: pick(DRAWN_DIAGRAMS),
    gamut: randomGamut(random),
    model: pick(COLOR_MODELS),
    signal: pick(SCOPE_SIGNALS),
    vectorStyle: pick(VECTOR_STYLES),
    waveStyle: pick(WAVE_STYLES),
    phosphor: pick(PHOSPHORS),
    overlay: pick(OVERLAY_ODDS),
    transform: pick(TRANSFORMS),
    chromaticity: pick(CHROMATICITY_VIEWS),
    spectrum: pick(SPECTRUM_VIEWS),
    curve: pick(CURVE_VIEWS),
    pixel: pick(PIXEL_VIEWS),
    seed: Math.floor(random() * 2 ** 32),
  };
}

const CHANCE_FIELDS = ["gamut", "signal", "vectorStyle", "waveStyle", "phosphor", "overlay", "transform", "chromaticity", "spectrum", "curve", "pixel"] as const;

/** What this visit shows. `chance` fills in whatever was left random; "random" leaves everything. */
export function homeDrawing(settings: HomeDiagramPreferences, chance: HomeDrawing): HomeDrawing | null {
  if (settings.diagram === "off") return null;
  if (settings.diagram === "random") return chance;
  const drawing: HomeDrawing = { ...chance, diagram: settings.diagram, model: settings.model };
  for (const field of CHANCE_FIELDS) {
    if (settings[field] !== "random") (drawing as Record<string, unknown>)[field] = settings[field];
  }
  return drawing;
}

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T) {
  return options.includes(value as T) ? value as T : fallback;
}

export function resolveHomeDiagram(raw: string | null): HomeDiagramPreferences {
  let input: Partial<HomeDiagramPreferences> = {};
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed?.version === 2) input = parsed;
  } catch {
    /* Invalid preferences use the default diagram. */
  }
  const fallback = DEFAULT_HOME_DIAGRAM;
  return {
    version: 2,
    diagram: oneOf(HOME_DIAGRAMS, input.diagram, fallback.diagram),
    gamut: oneOf(GAMUT_CHOICES, input.gamut, fallback.gamut),
    model: oneOf(COLOR_MODELS, input.model, fallback.model),
    signal: oneOf(SIGNAL_CHOICES, input.signal, fallback.signal),
    vectorStyle: oneOf(VECTOR_STYLE_CHOICES, input.vectorStyle, fallback.vectorStyle),
    waveStyle: oneOf(WAVE_STYLE_CHOICES, input.waveStyle, fallback.waveStyle),
    phosphor: oneOf(PHOSPHOR_CHOICES, input.phosphor, fallback.phosphor),
    overlay: oneOf(OVERLAY_CHOICES, input.overlay, fallback.overlay),
    transform: oneOf(TRANSFORM_CHOICES, input.transform, fallback.transform),
    chromaticity: oneOf(CHROMATICITY_CHOICES, input.chromaticity, fallback.chromaticity),
    spectrum: oneOf(SPECTRUM_CHOICES, input.spectrum, fallback.spectrum),
    curve: oneOf(CURVE_CHOICES, input.curve, fallback.curve),
    pixel: oneOf(PIXEL_CHOICES, input.pixel, fallback.pixel),
  };
}

// Undefined means storage owns the value; null is an unsaved reset to defaults.
let unsaved: string | null | undefined;

function readRaw() {
  if (unsaved !== undefined) return unsaved;
  try {
    return window.localStorage.getItem(HOME_DIAGRAM_STORAGE_KEY);
  } catch {
    return null;
  }
}

function subscribe(notify: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key === HOME_DIAGRAM_STORAGE_KEY || event.key === null) {
      unsaved = undefined;
      notify();
    }
  }
  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener("storage", onStorage);
  };
}

export function saveHomeDiagram(next: HomeDiagramPreferences | null) {
  const raw = next && JSON.stringify(next);
  try {
    if (raw) window.localStorage.setItem(HOME_DIAGRAM_STORAGE_KEY, raw);
    else window.localStorage.removeItem(HOME_DIAGRAM_STORAGE_KEY);
    unsaved = undefined;
  } catch {
    // Failed writes can leave an older readable value; prefer this local choice.
    unsaved = raw;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Null until the browser's choice is known, so the server renders no diagram. */
export function useHomeDiagram() {
  const raw = useSyncExternalStore<string | null | undefined>(subscribe, readRaw, () => undefined);
  return raw === undefined ? null : resolveHomeDiagram(raw);
}
