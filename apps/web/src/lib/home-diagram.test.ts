import { describe, expect, it } from "vitest";
import { CHROMATICITY_VIEWS } from "./chromaticity";
import { TRANSFORMS } from "./color-transform";
import { COLOR_MODELS, GAMUTS, VOLUME_OVERLAYS } from "./color-volume";
import { PIXEL_VIEWS } from "./pixel-demos";
import { PHOSPHORS, SCOPE_SIGNALS, VECTOR_STYLES, WAVE_STYLES } from "./scope-signal";
import { SPECTRUM_VIEWS } from "./spectrum-views";
import { CURVE_VIEWS } from "./transfer-curves";
import {
  DEFAULT_HOME_DIAGRAM,
  homeDrawing,
  randomDrawing,
  randomGamut,
  resolveHomeDiagram,
  type HomeDrawing,
} from "./home-diagram";

describe("resolveHomeDiagram", () => {
  it("starts on the default diagram", () => {
    expect(resolveHomeDiagram(null)).toEqual(DEFAULT_HOME_DIAGRAM);
  });

  it("keeps a valid choice, including turning the diagram off", () => {
    const off = { ...DEFAULT_HOME_DIAGRAM, diagram: "off", gamut: "ap0", model: "cam16", signal: "hue", vectorStyle: "zoom", waveStyle: "ycbcr", phosphor: "amber" };
    expect(resolveHomeDiagram(JSON.stringify(off))).toEqual(off);
  });

  it("keeps each newer diagram's own choice", () => {
    const pinned = {
      ...DEFAULT_HOME_DIAGRAM, diagram: "spectrum", gamut: "dwg", model: "zcam", overlay: "pointer",
      transform: "rgc", chromaticity: "macadam", spectrum: "tm30", curve: "film", pixel: "bayer",
    };
    expect(resolveHomeDiagram(JSON.stringify(pinned))).toEqual(pinned);
  });

  it("restores the xyY coordinate choice", () => {
    const preferences = { ...DEFAULT_HOME_DIAGRAM, diagram: "volume", gamut: "rec2020", model: "xyy" };
    expect(resolveHomeDiagram(JSON.stringify(preferences))).toEqual(preferences);
  });

  it("replaces unknown values one field at a time", () => {
    expect(resolveHomeDiagram(JSON.stringify({ version: 2, diagram: "lissajous", gamut: "rec709", model: 3 })))
      .toEqual({ ...DEFAULT_HOME_DIAGRAM, gamut: "rec709" });
  });

  it("gives older saved choices random options for everything added since", () => {
    expect(resolveHomeDiagram(JSON.stringify({ version: 2, diagram: "waveform", gamut: "p3", model: "xyy" })))
      .toEqual({ ...DEFAULT_HOME_DIAGRAM, diagram: "waveform", gamut: "p3", model: "xyy" });
  });

  it("ignores broken and future payloads", () => {
    expect(resolveHomeDiagram("{")).toEqual(DEFAULT_HOME_DIAGRAM);
    expect(resolveHomeDiagram(JSON.stringify({ version: 3, diagram: "off" }))).toEqual(DEFAULT_HOME_DIAGRAM);
  });
});

describe("randomDrawing", () => {
  it("can land on every diagram and every option", () => {
    const lists = {
      diagram: 8, gamut: GAMUTS.length, model: COLOR_MODELS.length, signal: SCOPE_SIGNALS.length,
      vectorStyle: VECTOR_STYLES.length, waveStyle: WAVE_STYLES.length, phosphor: PHOSPHORS.length,
      overlay: VOLUME_OVERLAYS.length, transform: TRANSFORMS.length, chromaticity: CHROMATICITY_VIEWS.length,
      spectrum: SPECTRUM_VIEWS.length, curve: CURVE_VIEWS.length, pixel: PIXEL_VIEWS.length,
    } as const;
    const seen = Object.fromEntries(Object.keys(lists).map(field => [field, new Set()])) as Record<keyof typeof lists, Set<unknown>>;
    for (let step = 0; step < 1000; step++) {
      const drawing = randomDrawing(() => step / 1000);
      for (const field of Object.keys(lists) as (keyof typeof lists)[]) seen[field].add(drawing[field]);
    }
    for (const [field, count] of Object.entries(lists)) expect(seen[field as keyof typeof lists].size, field).toBe(count);
  });

  it("never draws the off choice", () => {
    expect(randomDrawing(() => 0).diagram).toBe("vectorscope");
    expect(randomDrawing(() => 0.999999).diagram).toBe("pixel");
  });
});

describe("homeDrawing", () => {
  const chance: HomeDrawing = {
    diagram: "waveform", gamut: "ap0", model: "oklab", signal: "hue", vectorStyle: "points",
    waveStyle: "rgb", phosphor: "green", overlay: "gradient", transform: "agx", chromaticity: "hue",
    spectrum: "metamer", curve: "tonemap", pixel: "mixing", seed: 7,
  };

  it("draws nothing when off", () => {
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, diagram: "off" }, chance)).toBeNull();
  });

  it("leaves everything to chance under random, whatever the volume rows say", () => {
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, gamut: "rec709", model: "xyy", signal: "bars75", phosphor: "amber" }, chance)).toEqual(chance);
  });

  it("keeps pinned choices and fills only the random gamut", () => {
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, diagram: "volume", model: "xyy" }, chance))
      .toEqual({ ...chance, diagram: "volume", gamut: "ap0", model: "xyy", overlay: "none" });
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, diagram: "vectorscope", gamut: "p3", signal: "checker", phosphor: "white" }, chance))
      .toEqual({ ...chance, diagram: "vectorscope", gamut: "p3", model: "xyz", signal: "checker", phosphor: "white", overlay: "none" });
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, diagram: "curve", curve: "film", overlay: "none" }, chance))
      .toEqual({ ...chance, diagram: "curve", model: "xyz", curve: "film", overlay: "none" });
  });
});

describe("randomGamut", () => {
  it("can land on every gamut and never leaves the list", () => {
    const steps = GAMUTS.map((_, index) => (index + 0.5) / GAMUTS.length);
    expect(steps.map(step => randomGamut(() => step))).toEqual([...GAMUTS]);
    expect(randomGamut(() => 0.999999)).toBe(GAMUTS.at(-1));
  });
});
