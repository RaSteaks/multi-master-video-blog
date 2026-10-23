import { describe, expect, it } from "vitest";
import {
  LIGHTBOX_GESTURE,
  aspectsMatch,
  axisOffset,
  boxIsVisible,
  createVelocityTracker,
  dismissProgress,
  flipTransform,
  gestureOutcome,
  lockGestureAxis,
  parseLayerTransform,
  swipeDuration,
  untransformedBox,
} from "./lightbox-gesture";

describe("axis locking", () => {
  it("stays undecided inside the slop circle so taps never become gestures", () => {
    expect(lockGestureAxis(6, 5, { canPage: true })).toBeNull();
  });

  it("locks horizontal paging and downward dismissal", () => {
    expect(lockGestureAxis(18, 3, { canPage: true })).toBe("x");
    expect(lockGestureAxis(-18, 3, { canPage: true })).toBe("x");
    expect(lockGestureAxis(2, 20, { canPage: true })).toBe("y");
  });

  it("rejects upward drags and paging an album of one photo", () => {
    expect(lockGestureAxis(2, -20, { canPage: true })).toBe("none");
    expect(lockGestureAxis(20, 1, { canPage: false })).toBe("none");
  });

  it("waits on an ambiguous diagonal, then gives it up", () => {
    expect(lockGestureAxis(12, 11, { canPage: true })).toBeNull();
    expect(lockGestureAxis(30, 29, { canPage: true })).toBe("none");
  });

  it("subtracts the slop so the photo does not jump when the axis locks", () => {
    expect(axisOffset(LIGHTBOX_GESTURE.slopPx)).toBe(0);
    expect(axisOffset(30)).toBe(20);
    expect(axisOffset(-30)).toBe(-20);
  });
});

describe("velocity sampling", () => {
  it("measures the slope over the recent window", () => {
    const tracker = createVelocityTracker();
    for (let t = 0; t <= 80; t += 16) tracker.add(t, -t, 0);
    expect(tracker.velocity(85).x).toBeCloseTo(-1, 5);
  });

  it("reports no momentum when the finger rested before lifting", () => {
    const tracker = createVelocityTracker();
    for (let t = 0; t <= 80; t += 16) tracker.add(t, -t * 2, 0);
    expect(tracker.velocity(80 + LIGHTBOX_GESTURE.restMs + 1)).toEqual({ x: 0, y: 0 });
  });

  it("ignores spans too short to measure and clamps glitched spikes", () => {
    const sparse = createVelocityTracker();
    sparse.add(0, 0, 0);
    sparse.add(4, 200, 0);
    expect(sparse.velocity(5)).toEqual({ x: 0, y: 0 });
    const spike = createVelocityTracker();
    spike.add(0, 0, 0);
    spike.add(20, 900, 0);
    expect(spike.velocity(21).x).toBe(LIGHTBOX_GESTURE.maxVelocity);
  });
});

describe("release outcome", () => {
  const viewport = 400;

  it("pages by distance in either direction, matching the looped album", () => {
    expect(gestureOutcome({ axis: "x", offset: -100, velocity: 0, viewport })).toBe("next");
    expect(gestureOutcome({ axis: "x", offset: 100, velocity: 0, viewport })).toBe("previous");
  });

  it("pages by a short flick but not by a twitch or a reversed flick", () => {
    expect(gestureOutcome({ axis: "x", offset: -30, velocity: -0.8, viewport })).toBe("next");
    expect(gestureOutcome({ axis: "x", offset: -12, velocity: -2, viewport })).toBe("return");
    expect(gestureOutcome({ axis: "x", offset: -40, velocity: 0.8, viewport })).toBe("return");
  });

  it("returns a short slow drag", () => {
    expect(gestureOutcome({ axis: "x", offset: -40, velocity: -0.1, viewport })).toBe("return");
  });

  it("dismisses by pull distance or a downward flick, not when pushed back up", () => {
    expect(gestureOutcome({ axis: "y", offset: 140, velocity: 0, viewport: 700 })).toBe("dismiss");
    expect(gestureOutcome({ axis: "y", offset: 40, velocity: 0.9, viewport: 700 })).toBe("dismiss");
    expect(gestureOutcome({ axis: "y", offset: 140, velocity: -0.9, viewport: 700 })).toBe("return");
    expect(gestureOutcome({ axis: "y", offset: 50, velocity: 0.1, viewport: 700 })).toBe("return");
  });

  it("never acts on a rejected axis", () => {
    expect(gestureOutcome({ axis: "none", offset: 300, velocity: 3, viewport })).toBe("return");
  });

  it("scales pull progress to half the viewport", () => {
    expect(dismissProgress(-20, 800)).toBe(0);
    expect(dismissProgress(200, 800)).toBe(0.5);
    expect(dismissProgress(900, 800)).toBe(1);
  });
});

describe("transform geometry", () => {
  it("reads translate and scale back from computed matrices", () => {
    expect(parseLayerTransform("none")).toEqual({ x: 0, y: 0, scale: 1 });
    expect(parseLayerTransform("matrix(0.9, 0, 0, 0.9, -42.5, 18)")).toEqual({ x: -42.5, y: 18, scale: 0.9 });
    expect(parseLayerTransform("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, -4, 0, 1)"))
      .toEqual({ x: 30, y: -4, scale: 1 });
  });

  it("maps a lightbox photo onto its tile and recovers the untransformed box", () => {
    const photo = { left: 100, top: 50, width: 800, height: 600 };
    const tile = { left: 20, top: 400, width: 200, height: 150 };
    const flip = flipTransform(photo, tile);
    expect(flip).toEqual({ x: -380, y: 125, scale: 0.25 });
    const drawn = { left: 120, top: 330, width: 400, height: 300 };
    expect(untransformedBox(drawn, { x: 20, y: 30, scale: 0.5 }))
      .toEqual({ left: -100, top: 150, width: 800, height: 600 });
  });

  it("only morphs between matching shapes and tiles that are actually on screen", () => {
    expect(aspectsMatch({ left: 0, top: 0, width: 300, height: 200 }, { left: 0, top: 0, width: 150, height: 101 })).toBe(true);
    expect(aspectsMatch({ left: 0, top: 0, width: 300, height: 200 }, { left: 0, top: 0, width: 160, height: 200 })).toBe(false);
    const viewport = { width: 1000, height: 800 };
    expect(boxIsVisible({ left: 10, top: 10, width: 200, height: 150 }, viewport)).toBe(true);
    expect(boxIsVisible({ left: 10, top: 760, width: 200, height: 150 }, viewport)).toBe(false);
    expect(boxIsVisible({ left: 10, top: 10, width: 0, height: 0 }, viewport)).toBe(false);
  });

  it("carries release speed into the swipe duration within the token bounds", () => {
    expect(swipeDuration(300, 0.1, 180, 260)).toBe(180);
    expect(swipeDuration(300, 3, 180, 260)).toBe(121);
    expect(swipeDuration(300, 0.5, 180, 260)).toBe(260);
    expect(swipeDuration(300, 2, 0, 260)).toBe(0);
  });
});
