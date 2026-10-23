import { describe, expect, it, vi } from "vitest";
import { motionTokensFrom, parseMotionDuration } from "./media-motion";
import { captureVideoFrame, isEditableTarget, masterShortcutIndex, waitForPresentedFrame } from "./master-switch";

describe("master shortcuts", () => {
  const key = (value: string, extra: Record<string, unknown> = {}) => ({ key: value, target: { tagName: "VIDEO" }, ...extra });

  it("maps 1–3 to available masters only", () => {
    expect(masterShortcutIndex(key("1"), 4)).toBe(0);
    expect(masterShortcutIndex(key("3"), 4)).toBe(2);
    expect(masterShortcutIndex(key("4"), 4)).toBeNull();
    expect(masterShortcutIndex(key("3"), 2)).toBeNull();
    expect(masterShortcutIndex(key("0"), 4)).toBeNull();
    expect(masterShortcutIndex(key("k"), 4)).toBeNull();
  });

  it("leaves modified keys, auto-repeat, IME composition and handled events alone", () => {
    for (const extra of [
      { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
      { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true },
    ]) {
      expect(masterShortcutIndex(key("1", extra), 3)).toBeNull();
    }
    expect(masterShortcutIndex(key("Process"), 3)).toBeNull();
  });

  it("never steals digits typed into fields", () => {
    for (const target of [{ tagName: "input" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      expect(isEditableTarget(target)).toBe(true);
      expect(masterShortcutIndex(key("1", { target }), 3)).toBeNull();
    }
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
  });
});

function fakeVideo(state: Partial<{ readyState: number; seeking: boolean; currentTime: number; videoWidth: number; videoHeight: number }> = {}) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    readyState: 1,
    seeking: false,
    currentTime: 0,
    videoWidth: 640,
    videoHeight: 360,
    ...state,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      listeners.get(type)?.forEach((listener) => listener());
    },
    listenerCount() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
  };
}

const immediateFrames = { requestFrame: (callback: () => void) => (queueMicrotask(callback), 1), cancelFrame: () => {} };

describe("presented frame wait", () => {
  it("prefers requestVideoFrameCallback and cleans up its listeners", async () => {
    const video = fakeVideo({ readyState: 4 });
    let presented: ((now: number, metadata: { mediaTime: number }) => void) | null = null;
    const cancel = vi.fn();
    const result = waitForPresentedFrame(Object.assign(video, {
      requestVideoFrameCallback: (callback: (now: number, metadata: { mediaTime: number }) => void) => ((presented = callback), 7),
      cancelVideoFrameCallback: cancel,
    }), { ...immediateFrames, timeoutMs: 1000 });
    presented!(0, { mediaTime: 0 });
    await expect(result).resolves.toBe("frame");
    expect(video.listenerCount()).toBe(0);
  });

  it("does not claim a presented frame from readyState while a video-frame callback is pending", async () => {
    let presented: ((now: number, metadata: { mediaTime: number }) => void) | null = null;
    const requestFrame = vi.fn(immediateFrames.requestFrame);
    const result = waitForPresentedFrame(Object.assign(fakeVideo({ readyState: 4 }), {
      requestVideoFrameCallback: (callback: (now: number, metadata: { mediaTime: number }) => void) => ((presented = callback), 7),
      cancelVideoFrameCallback: vi.fn(),
    }), { ...immediateFrames, requestFrame, timeoutMs: 1000 });
    let finished = false;
    void result.then(() => { finished = true; });
    // A decoded but not yet composited frame must not be bypassed by ordinary rAFs.
    await Promise.resolve();
    await Promise.resolve();
    expect(requestFrame).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    presented!(0, { mediaTime: 0 });
    await expect(result).resolves.toBe("frame");
  });

  it("ignores a video-frame callback arriving during an unfinished seek", async () => {
    const video = fakeVideo({ readyState: 4, seeking: true });
    let presented: ((now: number, metadata: { mediaTime: number }) => void) | null = null;
    const result = waitForPresentedFrame(Object.assign(video, {
      requestVideoFrameCallback: (callback: (now: number, metadata: { mediaTime: number }) => void) => ((presented = callback), 7),
      cancelVideoFrameCallback: vi.fn(),
    }), { ...immediateFrames, timeoutMs: 1000 });
    let finished = false;
    void result.then(() => { finished = true; });
    presented!(0, { mediaTime: 0 });
    await Promise.resolve();
    expect(finished).toBe(false);
    video.seeking = false;
    video.emit("seeked");
    await expect(result).resolves.toBe("frame");
  });

  it("rejects a composited frame from the old playback position", async () => {
    const video = fakeVideo({ readyState: 4, currentTime: 1.2 });
    let presented: ((now: number, metadata: { mediaTime: number }) => void) | null = null;
    const result = waitForPresentedFrame(Object.assign(video, {
      requestVideoFrameCallback: (callback: (now: number, metadata: { mediaTime: number }) => void) => ((presented = callback), 7),
      cancelVideoFrameCallback: vi.fn(),
    }), { ...immediateFrames, timeoutMs: 1000 });
    let finished = false;
    void result.then(() => { finished = true; });
    presented!(0, { mediaTime: 0 });
    await Promise.resolve();
    expect(finished).toBe(false);
    presented!(0, { mediaTime: 1.2 });
    await expect(result).resolves.toBe("frame");
  });

  it("falls back to a settled, non-seeking element with current data", async () => {
    const video = fakeVideo({ readyState: 1, seeking: true });
    const result = waitForPresentedFrame(video, { ...immediateFrames, timeoutMs: 1000 });
    video.readyState = 4;
    video.emit("canplay");
    video.seeking = false;
    video.emit("seeked");
    await expect(result).resolves.toBe("ready");
  });

  it("is bounded and cancellable", async () => {
    vi.useFakeTimers();
    const stuck = waitForPresentedFrame(fakeVideo(), { ...immediateFrames, timeoutMs: 500 });
    vi.advanceTimersByTime(500);
    await expect(stuck).resolves.toBe("timeout");
    vi.useRealTimers();
    const controller = new AbortController();
    const pending = waitForPresentedFrame(fakeVideo(), { ...immediateFrames, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBe("aborted");
    await expect(waitForPresentedFrame(fakeVideo(), { signal: controller.signal })).resolves.toBe("aborted");
  });
});

function fakeCanvas(alpha: number, { tainted = false } = {}) {
  return {
    width: 0,
    height: 0,
    drawn: 0,
    getContext() {
      return {
        drawImage: () => { this.drawn += 1; },
        getImageData: () => {
          if (tainted) throw new DOMException("tainted", "SecurityError");
          return { data: [0, 0, 0, alpha] };
        },
      };
    },
  };
}

describe("freeze frame capture", () => {
  it("captures a painted frame at a bounded size", () => {
    const canvas = fakeCanvas(255);
    expect(captureVideoFrame({ readyState: 4, videoWidth: 3840, videoHeight: 2160 }, canvas)).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
  });

  it("declines frames it cannot present or verify, releasing the canvas", () => {
    expect(captureVideoFrame({ readyState: 1, videoWidth: 640, videoHeight: 360 }, fakeCanvas(255))).toBe(false);
    const empty = fakeCanvas(0);
    expect(captureVideoFrame({ readyState: 4, videoWidth: 640, videoHeight: 360 }, empty)).toBe(false);
    expect([empty.width, empty.height]).toEqual([0, 0]);
    const crossOrigin = fakeCanvas(255, { tainted: true });
    expect(captureVideoFrame({ readyState: 4, videoWidth: 640, videoHeight: 360 }, crossOrigin)).toBe(false);
    expect(crossOrigin.width).toBe(0);
  });
});

describe("motion tokens", () => {
  it("reads the globals.css contract and treats missing values as no animation", () => {
    const values: Record<string, string> = {
      "--motion-media-duration": " 180ms",
      "--motion-panel-duration": "0.26s",
      "--motion-ease": " cubic-bezier(0.22, 1, 0.36, 1)",
    };
    const tokens = motionTokensFrom({ getPropertyValue: (name) => values[name] ?? "" });
    expect(tokens.media).toBe(180);
    expect(tokens.panel).toBe(260);
    expect(tokens.reduced).toBe(0);
    expect(tokens.ease).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(parseMotionDuration("fast")).toBeNull();
  });
});
