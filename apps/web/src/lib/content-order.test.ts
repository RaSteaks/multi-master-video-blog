import { describe, expect, it, vi } from "vitest";

vi.mock("./author-session", () => ({ authorHeaders: () => ({}), observeAuthorResponse: () => {} }));

const { applyOrder, moveId, nearestSlot } = await import("./content-order");

describe("applyOrder", () => {
  it("leaves the server's order alone until the author arranges", () => {
    expect(applyOrder([1, 2, 3], null)).toEqual([1, 2, 3]);
  });

  it("outlives a refresh that still carries the old order", () => {
    expect(applyOrder([1, 2, 3], [3, 1, 2])).toEqual([3, 1, 2]);
  });

  it("keeps a work added since at the front", () => {
    expect(applyOrder([9, 1, 2, 3], [3, 1, 2])).toEqual([9, 3, 1, 2]);
  });

  it("keeps works loaded later at the end", () => {
    expect(applyOrder([1, 2, 3, 4, 5], [3, 1, 2])).toEqual([3, 1, 2, 4, 5]);
  });

  it("drops a work that has since gone", () => {
    expect(applyOrder([1, 3], [3, 2, 1])).toEqual([3, 1]);
  });
});

describe("moveId", () => {
  it("moves forward and backward", () => {
    expect(moveId([1, 2, 3, 4], 1, 2)).toEqual([2, 3, 1, 4]);
    expect(moveId([1, 2, 3, 4], 4, 0)).toEqual([4, 1, 2, 3]);
  });

  it("stays within the list", () => {
    expect(moveId([1, 2, 3], 2, 99)).toEqual([1, 3, 2]);
    expect(moveId([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
  });
});

describe("nearestSlot", () => {
  const slots = [0, 1, 2].map(column => ({ id: column + 1, left: column * 100, top: 0, width: 90, height: 60 }));

  it("stays put near its own slot", () => {
    expect(nearestSlot(slots, 1, 60, 30)).toBeNull();
  });

  it("swaps once the card is clearly nearer another slot", () => {
    expect(nearestSlot(slots, 1, 130, 30)).toBe(2);
    expect(nearestSlot(slots, 1, 240, 30)).toBe(3);
  });

  it("does not swap at the midpoint, where two rows could trade forever", () => {
    expect(nearestSlot(slots, 1, 95, 30)).toBeNull();
  });
});
