import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiquidFluidRenderer,
  FLUID_TARGET_FPS,
  fluidGridSize,
} from "./liquid-fluid";

describe("low-resolution liquid grid", () => {
  it("keeps desktop and mobile grids at their configured low resolution", () => {
    expect(fluidGridSize(1920, 1080, 64)).toEqual({ width: 64, height: 64 });
    expect(fluidGridSize(390, 844, 48)).toEqual({ width: 48, height: 48 });
  });

  it("repairs invalid simulation size values", () => {
    const result = fluidGridSize(Number.NaN, 0, Number.NaN);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(Number.isFinite(result.width)).toBe(true);
    expect(Number.isFinite(result.height)).toBe(true);
  });

  it("limits animation work to the low-resource target cadence", () => {
    expect(FLUID_TARGET_FPS).toBe(30);
  });
});


afterEach(() => vi.unstubAllGlobals());

it("draws paused initialization, palette edits and resize without scheduling animation", () => {
  const draw = vi.fn();
  const uniform = vi.fn();
  const schedule = vi.fn(() => 1);
  const constants = { FRAMEBUFFER_COMPLETE: 1, COMPILE_STATUS: 2, LINK_STATUS: 3 };
  const gl = new Proxy(constants, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
      if (key === "checkFramebufferStatus") return () => 1;
      if (key === "drawArrays") return draw;
      if (key === "uniform1f" || key === "uniform3f") return uniform;
      if (key === "getUniformLocation") return (_: unknown, name: string) => name;
      if (key === "getExtension" || String(key).startsWith("create")) return () => ({});
      return () => {};
    },
  });
  const listeners = new Map<string, () => void>();
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false }), innerWidth: 1000, innerHeight: 800,
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  vi.stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("requestAnimationFrame", schedule);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  let width = 1000;
  const canvas = {
    getContext: () => gl, getBoundingClientRect: () => ({ width, height: 800 }),
    addEventListener() {}, removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  const palette = [[0.5, 0.5, 0.5], [0.4, 0.4, 0.4], [0.3, 0.3, 0.3]] as const;
  const controller = createLiquidFluidRenderer(canvas, { variant: "gray", speed: 0, palette });
  expect(controller).not.toBeNull();
  expect(draw).toHaveBeenCalled();
  expect(uniform).toHaveBeenCalledWith("u_initialize", 1);
  expect(uniform).toHaveBeenCalledWith("u_dt", 0);
  expect(schedule).not.toHaveBeenCalled();
  try {
    draw.mockClear();
    uniform.mockClear();
    controller!.update({ speed: 0, palette: [[1, 0, 0], [1, 0, 0], [1, 0, 0]] });
    expect(draw).toHaveBeenCalled();
    expect(uniform).toHaveBeenCalledWith("u_color1", 1, 0, 0);
    expect(uniform).toHaveBeenCalledWith("u_time", 0);
    draw.mockClear();
    width = 800;
    listeners.get("resize")!();
    expect(draw).toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    controller!.update({ speed: 1, palette });
    expect(schedule).toHaveBeenCalledOnce();
  } finally {
    controller?.dispose();
  }
});
