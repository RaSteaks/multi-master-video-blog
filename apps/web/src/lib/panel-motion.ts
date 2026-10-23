type RunningMotion = { animations: Animation[]; finish: () => void };

const running = new WeakMap<HTMLElement, RunningMotion>();

/** Cancel only this utility's effects; panel opening and unrelated controls keep their animations. */
export function cancelPanelMotion(content: HTMLElement | null) {
  if (!content) return;
  const previous = running.get(content);
  if (!previous) return;
  previous.animations.forEach((animation) => animation.cancel());
  previous.finish();
}

/**
 * Commit state synchronously, then decorate the live panel without a document snapshot.
 * The caller owns the React commit (flushSync); animation never delays or repeats it.
 * A new selection starts from the current rendered height, even during an interrupted resize.
 */
export function animatePanelChange(
  content: HTMLElement | null,
  update: () => void,
  direction: -1 | 0 | 1 = 0,
) {
  const fromHeight = content?.getBoundingClientRect().height ?? 0;
  cancelPanelMotion(content);
  update();
  if (!content?.isConnected || typeof content.animate !== "function") return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const style = getComputedStyle(content);
  const duration = parseFloat(style.getPropertyValue(
    reducedMotion.matches ? "--motion-reduced-duration" : "--motion-panel-duration",
  ));
  // Tokens are supplied by globals.css. A missing contract must never hide content.
  if (!Number.isFinite(duration) || duration <= 0) return;
  const distance = parseFloat(style.getPropertyValue("--motion-panel-distance")) || 0;
  const easing = style.getPropertyValue("--motion-ease").trim() || "ease-out";
  const child = content.firstElementChild;
  if (!(child instanceof HTMLElement)) return;

  const motion: RunningMotion = {
    animations: [],
    finish() {
      // An older completion must not remove the current selection's clipping or effects.
      if (running.get(content) !== motion) return;
      running.delete(content);
      delete content.dataset.panelAnimating;
      reducedMotion.removeEventListener("change", onPreferenceChange);
    },
  };
  function onPreferenceChange() {
    if (reducedMotion.matches) cancelPanelMotion(content);
  }
  running.set(content, motion);
  reducedMotion.addEventListener("change", onPreferenceChange);
  const toHeight = content.getBoundingClientRect().height;

  try {
    const start: Keyframe = { opacity: 0 };
    const end: Keyframe = { opacity: 1 };
    if (!reducedMotion.matches && direction !== 0) {
      start.transform = `translateX(${direction * distance}px)`;
      end.transform = "translateX(0)";
    }
    motion.animations.push(child.animate([start, end], { duration, easing }));
    if (!reducedMotion.matches && Math.abs(fromHeight - toHeight) > 1) {
      content.dataset.panelAnimating = "true";
      motion.animations.push(content.animate(
        [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
        { duration, easing },
      ));
    }
    void Promise.allSettled(motion.animations.map((animation) => animation.finished))
      .then(motion.finish);
  } catch {
    // Partial WAAPI implementations still get the committed, usable final state.
    void Promise.allSettled(motion.animations.map((animation) => animation.finished));
    cancelPanelMotion(content);
  }
}
