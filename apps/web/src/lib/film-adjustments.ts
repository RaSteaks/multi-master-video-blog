export type FilmMaskAdjustments = {
  maskMode: "auto" | "manual" | "preset";
  maskRgb: [number, number, number] | null;
  filmBaseSample: { x: number; y: number; sourceId: number } | null;
};

export function changeFilmMaskMode<T extends FilmMaskAdjustments>(
  value: T,
  maskMode: FilmMaskAdjustments["maskMode"],
): T {
  return {
    ...value,
    maskMode,
    maskRgb: maskMode === "manual" ? value.maskRgb : null,
    filmBaseSample: null,
  };
}

export function changeFilmMaskRgb<T extends FilmMaskAdjustments>(
  value: T,
  maskRgb: [number, number, number],
): T {
  // Explicit RGB entry takes ownership from the previously sampled point.
  return { ...value, maskMode: "manual", maskRgb, filmBaseSample: null };
}
