import { expect, it } from "vitest";
import { changeFilmMaskMode, changeFilmMaskRgb, type FilmMaskAdjustments } from "./film-adjustments";

const sampled: FilmMaskAdjustments & { exposure: number } = {
  maskMode: "manual",
  maskRgb: [0.82, 0.61, 0.39],
  filmBaseSample: { x: 0.2, y: 0.3, sourceId: 7 },
  exposure: 1,
};

it.each(["auto", "preset"] as const)("switching to %s clears the previous manual mask and sample", mode => {
  const changed = changeFilmMaskMode(sampled, mode);
  expect(changed.maskMode).toBe(mode);
  expect(changed.maskRgb).toBeNull();
  expect(changed.filmBaseSample).toBeNull();
  expect(changed.exposure).toBe(1);
  expect(sampled.filmBaseSample?.sourceId).toBe(7);
});

it("editing RGB after point sampling removes the point from the next preview/save payload", () => {
  const changed = changeFilmMaskRgb(sampled, [0.5, 0.4, 0.3]);
  const payload = JSON.parse(JSON.stringify({ rollAdjustments: changed }));
  expect(payload.rollAdjustments.filmBaseSample).toBeNull();
  expect(payload.rollAdjustments.maskRgb).toEqual([0.5, 0.4, 0.3]);
  expect(payload.rollAdjustments.exposure).toBe(1);
});

it("returning to manual keeps the resolved RGB without reviving an old sample point", () => {
  const automatic = { ...changeFilmMaskMode(sampled, "auto"), maskRgb: [0.9, 0.7, 0.5] as [number, number, number] };
  const changed = changeFilmMaskMode(automatic, "manual");
  expect(changed.maskRgb).toEqual([0.9, 0.7, 0.5]);
  expect(changed.filmBaseSample).toBeNull();
});
