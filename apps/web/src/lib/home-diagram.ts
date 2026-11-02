import { useSyncExternalStore } from "react";
import { COLOR_MODELS, GAMUTS, type ColorModelId, type GamutId } from "./color-volume";
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

const DRAWN_DIAGRAMS = ["vectorscope", "waveform", "volume"] as const;
export type DrawnDiagram = (typeof DRAWN_DIAGRAMS)[number];
export const HOME_DIAGRAMS = ["off", "random", ...DRAWN_DIAGRAMS] as const;
export type HomeDiagramKind = (typeof HOME_DIAGRAMS)[number];
export const GAMUT_CHOICES = ["random", ...GAMUTS] as const;
export type GamutChoice = (typeof GAMUT_CHOICES)[number];
export const SIGNAL_CHOICES = ["random", ...SCOPE_SIGNALS] as const;
export const VECTOR_STYLE_CHOICES = ["random", ...VECTOR_STYLES] as const;
export const WAVE_STYLE_CHOICES = ["random", ...WAVE_STYLES] as const;
export const PHOSPHOR_CHOICES = ["random", ...PHOSPHORS] as const;
export type HomeDiagramPreferences = {
  version: 2;
  diagram: HomeDiagramKind;
  gamut: GamutChoice;
  model: ColorModelId;
  signal: (typeof SIGNAL_CHOICES)[number];
  vectorStyle: (typeof VECTOR_STYLE_CHOICES)[number];
  waveStyle: (typeof WAVE_STYLE_CHOICES)[number];
  phosphor: (typeof PHOSPHOR_CHOICES)[number];
};

export const HOME_DIAGRAM_STORAGE_KEY = "mm-home-diagram-v2";
const CHANGE_EVENT = "home-diagram-change";

export const DEFAULT_HOME_DIAGRAM: HomeDiagramPreferences = {
  version: 2, diagram: "random", gamut: "random", model: "xyz",
  signal: "random", vectorStyle: "random", waveStyle: "random", phosphor: "random",
};

/** The gamut a visit shows when the choice is left to chance. */
export function randomGamut(random = Math.random): GamutId {
  return GAMUTS[Math.floor(random() * GAMUTS.length)];
}

/** One complete drawing. Each diagram is equally likely, so the scopes are not lost among the solids. */
export type HomeDrawing = {
  diagram: DrawnDiagram;
  gamut: GamutId;
  model: ColorModelId;
  signal: ScopeSignal;
  vectorStyle: VectorStyle;
  waveStyle: WaveStyle;
  phosphor: Phosphor;
  seed: number;
};

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
    seed: Math.floor(random() * 2 ** 32),
  };
}

/** What this visit shows. `chance` fills in whatever was left random; "random" leaves everything. */
export function homeDrawing(settings: HomeDiagramPreferences, chance: HomeDrawing): HomeDrawing | null {
  if (settings.diagram === "off") return null;
  if (settings.diagram === "random") return chance;
  const { diagram, gamut, model, signal, vectorStyle, waveStyle, phosphor } = settings;
  return {
    ...chance, diagram, model,
    gamut: gamut === "random" ? chance.gamut : gamut,
    signal: signal === "random" ? chance.signal : signal,
    vectorStyle: vectorStyle === "random" ? chance.vectorStyle : vectorStyle,
    waveStyle: waveStyle === "random" ? chance.waveStyle : waveStyle,
    phosphor: phosphor === "random" ? chance.phosphor : phosphor,
  };
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
  return {
    version: 2,
    diagram: oneOf(HOME_DIAGRAMS, input.diagram, DEFAULT_HOME_DIAGRAM.diagram),
    gamut: oneOf(GAMUT_CHOICES, input.gamut, DEFAULT_HOME_DIAGRAM.gamut),
    model: oneOf(COLOR_MODELS, input.model, DEFAULT_HOME_DIAGRAM.model),
    signal: oneOf(SIGNAL_CHOICES, input.signal, DEFAULT_HOME_DIAGRAM.signal),
    vectorStyle: oneOf(VECTOR_STYLE_CHOICES, input.vectorStyle, DEFAULT_HOME_DIAGRAM.vectorStyle),
    waveStyle: oneOf(WAVE_STYLE_CHOICES, input.waveStyle, DEFAULT_HOME_DIAGRAM.waveStyle),
    phosphor: oneOf(PHOSPHOR_CHOICES, input.phosphor, DEFAULT_HOME_DIAGRAM.phosphor),
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
