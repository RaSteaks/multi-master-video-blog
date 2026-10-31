/**
 * Helpers for switching video masters on a single <video>/decoder: the 1–3 key
 * shortcuts, the SDR freeze frame held during a switch, and confirming that the
 * new master has actually presented a picture before the hold is released.
 */
export const MASTER_SHORTCUT_LIMIT = 3;
/** Loading feedback appears only for loads that outlast this. */
export const LOADING_HINT_DELAY_MS = 150;
/** Upper bound for holding a freeze frame when no frame callback ever arrives. */
export const FRAME_WAIT_TIMEOUT_MS = 2500;
/** Keeps the captured bitmap bounded (a 4K SDR frame would otherwise be ~33 MB). */
export const FREEZE_FRAME_MAX_WIDTH = 1920;

type ShortcutTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

type ShortcutEvent = {
  key: string;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
};

export function isEditableTarget(target: unknown) {
  if (!target || typeof target !== "object") return false;
  const element = target as ShortcutTarget;
  const tag = element.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true;
}

/**
 * Zero-based master index for a 1–3 key press, or null when the key must be left
 * to the browser: modified keys, auto-repeat, IME composition (keyCode 229 /
 * "Process"), typing into a field, or a digit with no master behind it.
 */
export function masterShortcutIndex(
  event: ShortcutEvent,
  masterCount: number,
  limit = MASTER_SHORTCUT_LIMIT,
) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null;
  if (event.key === "Process" || event.keyCode === 229) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (isEditableTarget(event.target)) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  const index = Number(event.key) - 1;
  return index < Math.min(limit, masterCount) ? index : null;
}

type FrameVideo = {
  readyState: number;
  seeking: boolean;
  currentTime: number;
  videoWidth: number;
  videoHeight: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type FrameWaitResult = "frame" | "ready" | "timeout" | "aborted";

/**
 * Resolves once the video has presented a picture for its current position:
 * requestVideoFrameCallback when supported, otherwise a settled, non-seeking
 * element with current data plus two animation frames for
 * compositing. Always bounded by `timeoutMs`, and cancellable through `signal`.
 */
export function waitForPresentedFrame(
  video: FrameVideo,
  {
    timeoutMs = FRAME_WAIT_TIMEOUT_MS,
    signal,
    requestFrame = (callback: () => void) =>
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(callback)
        : (setTimeout(callback, 16) as unknown as number),
    cancelFrame = (handle: number) =>
      typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(handle) : clearTimeout(handle),
  }: {
    timeoutMs?: number;
    signal?: AbortSignal;
    requestFrame?: (callback: () => void) => number;
    cancelFrame?: (handle: number) => void;
  } = {},
): Promise<FrameWaitResult> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    let settled = false;
    let videoFrameHandle: number | null = null;
    let frameHandle: number | null = null;
    let usesVideoFrames = typeof video.requestVideoFrameCallback === "function";
    let presentedTime: number | null = null;
    const events = ["seeked", "loadeddata", "canplay", "playing"] as const;

    function finish(result: FrameWaitResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      events.forEach((type) => video.removeEventListener(type, check));
      if (videoFrameHandle !== null) video.cancelVideoFrameCallback?.(videoFrameHandle);
      if (frameHandle !== null) cancelFrame(frameHandle);
      resolve(result);
    }
    function onAbort() {
      finish("aborted");
    }
    function check() {
      // readyState only proves decoded data exists, not that the compositor has
      // shown it. Do not let a pair of rAFs beat the browser's actual frame signal.
      if (settled || frameHandle !== null) return;
      if (video.seeking || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      if (usesVideoFrames) {
        // In WebKit the target picture may be composited before seeked. Keep its
        // media timestamp and confirm it when the element settles, rather than
        // waiting forever for another frame from an already-paused video.
        if (presentedTime !== null && Math.abs(presentedTime - video.currentTime) <= 0.35) finish("frame");
        return;
      }
      frameHandle = requestFrame(() => {
        frameHandle = requestFrame(() => {
          frameHandle = null;
          // A seek that started meanwhile has not presented its picture yet.
          if (video.seeking || video.readyState < 2) return;
          finish("ready");
        });
      });
    }

    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort);
    function requestVideoFrame() {
      try {
        videoFrameHandle = video.requestVideoFrameCallback!((_now, metadata) => {
          videoFrameHandle = null;
          presentedTime = Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : null;
          check();
          if (!settled) requestVideoFrame();
        });
      } catch {
        videoFrameHandle = null;
        usesVideoFrames = false;
        check();
      }
    }
    if (usesVideoFrames) requestVideoFrame();
    events.forEach((type) => video.addEventListener(type, check));
    check();
  });
}

type CaptureCanvas = {
  width: number;
  height: number;
  getContext(type: "2d"): {
    drawImage(source: unknown, x: number, y: number, width: number, height: number): void;
    getImageData(x: number, y: number, width: number, height: number): { data: ArrayLike<number> };
  } | null;
};

/**
 * Draws the current SDR frame into `canvas`. False — and a released canvas — when
 * there is no decoded frame, drawing fails, the canvas is cross-origin tainted (it
 * cannot be verified), or nothing was actually painted (fully transparent samples).
 */
export function captureVideoFrame(
  video: Pick<FrameVideo, "readyState" | "videoWidth" | "videoHeight">,
  canvas: CaptureCanvas,
  maxWidth = FREEZE_FRAME_MAX_WIDTH,
) {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context");
    context.drawImage(video, 0, 0, width, height);
    const points: Array<[number, number]> = [
      [0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
    ];
    const painted = points.some(([px, py]) => {
      const { data } = context.getImageData(Math.floor(width * px), Math.floor(height * py), 1, 1);
      return data[3] > 0;
    });
    if (!painted) throw new Error("Empty frame");
    return true;
  } catch {
    releaseCanvas(canvas);
    return false;
  }
}

export function releaseCanvas(canvas: Pick<CaptureCanvas, "width" | "height">) {
  // Zero dimensions release the backing store immediately.
  canvas.width = 0;
  canvas.height = 0;
}
