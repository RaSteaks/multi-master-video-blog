import { describe, expect, it } from "vitest";
import { GAMUTS } from "./color-volume";
import { COLOR_MODELS } from "./color-volume";
import { PHOSPHORS, SCOPE_SIGNALS, VECTOR_STYLES, WAVE_STYLES } from "./scope-signal";
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

  it("restores the xyY coordinate choice", () => {
    const preferences = { ...DEFAULT_HOME_DIAGRAM, diagram: "volume", gamut: "rec2020", model: "xyy" };
    expect(resolveHomeDiagram(JSON.stringify(preferences))).toEqual(preferences);
  });

  it("replaces unknown values one field at a time", () => {
    expect(resolveHomeDiagram(JSON.stringify({ version: 2, diagram: "lissajous", gamut: "rec709", model: 3 })))
      .toEqual({ ...DEFAULT_HOME_DIAGRAM, gamut: "rec709" });
  });

  it("gives older saved choices random scope options", () => {
    expect(resolveHomeDiagram(JSON.stringify({ version: 2, diagram: "waveform", gamut: "p3", model: "xyy" })))
      .toEqual({ ...DEFAULT_HOME_DIAGRAM, diagram: "waveform", gamut: "p3", model: "xyy" });
  });

  it("ignores broken and future payloads", () => {
    expect(resolveHomeDiagram("{")).toEqual(DEFAULT_HOME_DIAGRAM);
    expect(resolveHomeDiagram(JSON.stringify({ version: 3, diagram: "off" }))).toEqual(DEFAULT_HOME_DIAGRAM);
  });
});

describe("randomDrawing", () => {
  it("can land on every diagram, gamut and coordinate system", () => {
    const seen = { diagram: new Set(), gamut: new Set(), model: new Set(), signal: new Set(), vectorStyle: new Set(), waveStyle: new Set(), phosphor: new Set() };
    for (let step = 0; step < 1000; step++) {
      const { diagram, gamut, model, signal, vectorStyle, waveStyle, phosphor } = randomDrawing(() => step / 1000);
      seen.diagram.add(diagram); seen.gamut.add(gamut); seen.model.add(model); seen.signal.add(signal);
      seen.vectorStyle.add(vectorStyle); seen.waveStyle.add(waveStyle); seen.phosphor.add(phosphor);
    }
    expect(seen.diagram.size).toBe(3);
    expect(seen.gamut.size).toBe(GAMUTS.length);
    expect(seen.model.size).toBe(COLOR_MODELS.length);
    expect(seen.signal.size).toBe(SCOPE_SIGNALS.length);
    expect(seen.vectorStyle.size).toBe(VECTOR_STYLES.length);
    expect(seen.waveStyle.size).toBe(WAVE_STYLES.length);
    expect(seen.phosphor.size).toBe(PHOSPHORS.length);
  });

  it("never draws the off choice", () => {
    expect(randomDrawing(() => 0).diagram).toBe("vectorscope");
    expect(randomDrawing(() => 0.999999).diagram).toBe("volume");
  });
});

describe("homeDrawing", () => {
  const chance: HomeDrawing = {
    diagram: "waveform", gamut: "ap0", model: "oklab", signal: "hue", vectorStyle: "points",
    waveStyle: "rgb", phosphor: "green", seed: 7,
  };

  it("draws nothing when off", () => {
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, diagram: "off" }, chance)).toBeNull();
  });

  it("leaves everything to chance under random, whatever the volume rows say", () => {
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, gamut: "rec709", model: "xyy", signal: "bars75", phosphor: "amber" }, chance)).toEqual(chance);
  });

  it("keeps pinned choices and fills only the random gamut", () => {
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, diagram: "volume", model: "xyy" }, chance))
      .toEqual({ ...chance, diagram: "volume", gamut: "ap0", model: "xyy" });
    expect(homeDrawing({ ...DEFAULT_HOME_DIAGRAM, diagram: "vectorscope", gamut: "p3", signal: "checker", phosphor: "white" }, chance))
      .toEqual({ ...chance, diagram: "vectorscope", gamut: "p3", model: "xyz", signal: "checker", phosphor: "white" });
  });
});

describe("randomGamut", () => {
  it("can land on every gamut and never leaves the list", () => {
    const steps = GAMUTS.map((_, index) => (index + 0.5) / GAMUTS.length);
    expect(steps.map(step => randomGamut(() => step))).toEqual([...GAMUTS]);
    expect(randomGamut(() => 0.999999)).toBe(GAMUTS.at(-1));
  });
});
