import { afterEach, expect, it, vi } from "vitest";
import type { Application, Entity } from "playcanvas";
import { installSplatRenderScheduling } from "./splat-rendering";

afterEach(() => vi.unstubAllGlobals());

// Exercise scheduling transitions without loading a GPU scene or a large splat asset.
function events() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on(name: string, callback: () => void) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(callback);
    },
    off(name: string, callback: () => void) { handlers.get(name)?.delete(callback); },
    fire(name: string) { handlers.get(name)?.forEach((callback) => callback()); },
  };
}

it("renders movement, sorting and resize, pauses offscreen/hidden, and resumes without remounting", () => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", doc);
  let intersect: (entries: { isIntersecting: boolean }[]) => void;
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const matrix = new Float32Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  const app = {
    ...events(), scene: events(), graphicsDevice: { ...events(), canvas: {} },
    autoRender: true, renderNextFrame: false,
  };
  const dispose = installSplatRenderScheduling(
    app as unknown as Application,
    { getWorldTransform: () => ({ data: matrix }) } as unknown as Entity,
  );
  const frame = () => { app.fire("framerender"); return app.renderNextFrame; };
  expect(app.autoRender).toBe(false);
  expect(frame()).toBe(false);
  intersect!([{ isIntersecting: true }]);
  expect(frame()).toBe(true);
  expect(frame()).toBe(false);
  matrix[12] = 2;
  expect(frame()).toBe(true);
  expect(frame()).toBe(false);
  app.scene.fire("gsplat:sorted");
  expect(frame()).toBe(true);
  expect(frame()).toBe(false);
  app.graphicsDevice.fire("resizecanvas");
  expect(frame()).toBe(true);
  intersect!([{ isIntersecting: false }]);
  app.scene.fire("gsplat:sorted");
  expect(frame()).toBe(false);
  intersect!([{ isIntersecting: true }]);
  expect(frame()).toBe(true);
  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(frame()).toBe(false);
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(frame()).toBe(true);
  expect(frame()).toBe(false);
  dispose();
  expect(disconnect).toHaveBeenCalledOnce();
  app.scene.fire("gsplat:sorted");
  matrix[12] = 3;
  expect(frame()).toBe(false);
});
