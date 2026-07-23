import { describe, expect, it } from "vitest";
import { parseGaussianSplatConfig } from "./gaussian-splat";

describe("parseGaussianSplatConfig", () => {
  it("parses a complete 3DGS configuration", () => {
    const result = parseGaussianSplatConfig(
      JSON.stringify({
        src: "/media/3dgs/courtyard/scene.sog",
        title: "Courtyard",
        poster: "/media/3dgs/courtyard/poster.webp",
        height: 700,
        background: "#101214",
        cameraPosition: [1, 2, 3],
        target: [0, 1, 0],
        position: [0, -0.5, 0],
        rotation: [0, 180, 0],
        scale: [1.2, 1.2, 1.2],
      }),
    );

    expect(result).toEqual({
      ok: true,
      config: {
        src: "/media/3dgs/courtyard/scene.sog",
        title: "Courtyard",
        poster: "/media/3dgs/courtyard/poster.webp",
        height: 700,
        background: "#101214",
        cameraPosition: [1, 2, 3],
        target: [0, 1, 0],
        position: [0, -0.5, 0],
        rotation: [0, 180, 0],
        scale: [1.2, 1.2, 1.2],
      },
    });
  });

  it("applies defaults and clamps the viewer height", () => {
    const result = parseGaussianSplatConfig(
      '{"src":"https://assets.example.com/scene.compressed.ply","height":1200}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.height).toBe(820);
    expect(result.config.title).toBe("Interactive 3DGS scene");
    expect(result.config.cameraPosition).toEqual([0, 0, 2.5]);
  });

  it("supports streamed SOG metadata URLs with query strings", () => {
    const result = parseGaussianSplatConfig(
      '{"src":"/media/3dgs/city/lod-meta.json?v=2"}',
    );

    expect(result.ok).toBe(true);
  });

  it("rejects unsafe and unsupported sources", () => {
    expect(parseGaussianSplatConfig('{"src":"javascript:alert(1)"}').ok).toBe(false);
    expect(parseGaussianSplatConfig('{"src":"/media/model.glb"}').ok).toBe(false);
    expect(parseGaussianSplatConfig('{"src":"//example.com/scene.sog"}').ok).toBe(false);
  });

  it("returns an author-friendly error for invalid JSON", () => {
    expect(parseGaussianSplatConfig("{not-json")).toEqual({
      ok: false,
      error: "The 3dgs block must contain valid JSON.",
    });
  });

  it("rejects zero scale values", () => {
    expect(
      parseGaussianSplatConfig(
        '{"src":"/media/3dgs/scene.sog","scale":[1,0,1]}',
      ),
    ).toEqual({
      ok: false,
      error: 'Every value in "scale" must be non-zero.',
    });
  });
});
