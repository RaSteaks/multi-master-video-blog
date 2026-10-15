import type { Application, Entity } from "playcanvas";

/** Keep the camera's damping updates, but submit GPU frames only when something changes. */
export function installSplatRenderScheduling(app: Application, camera: Entity) {
  const canvas = app.graphicsDevice.canvas;
  const previousTransform = new Float32Array(16);
  let inViewport = typeof IntersectionObserver === "undefined";
  let dirty = true;

  const invalidate = () => { dirty = true; };
  const onVisibility = () => {
    dirty = true;
    if (document.hidden) app.renderNextFrame = false;
  };
  const beforeRender = () => {
    if (!inViewport || document.hidden) {
      app.renderNextFrame = false;
      return;
    }
    const transform = camera.getWorldTransform().data;
    const moved = transform.some((value, index) =>
      Math.abs(value - previousTransform[index]) > 0.00001,
    );
    app.renderNextFrame = dirty || moved;
    if (app.renderNextFrame) {
      previousTransform.set(transform);
      dirty = false;
    }
  };

  // Sorting completes asynchronously after camera movement; draw its result even when idle.
  app.autoRender = false;
  app.on("framerender", beforeRender);
  app.scene.on("gsplat:sorted", invalidate);
  app.graphicsDevice.on("resizecanvas", invalidate);
  document.addEventListener("visibilitychange", onVisibility);
  const observer = typeof IntersectionObserver === "undefined" ? null :
    new IntersectionObserver(([entry]) => {
      inViewport = entry.isIntersecting;
      dirty = true;
      if (!inViewport) app.renderNextFrame = false;
    });
  observer?.observe(canvas);

  return () => {
    observer?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    app.off("framerender", beforeRender);
    app.scene.off("gsplat:sorted", invalidate);
    app.graphicsDevice.off("resizecanvas", invalidate);
  };
}
