import { describe, expect, it } from "vitest";
import {
  albumFileKey,
  pairAlbumFileSelections,
} from "./album-management";

describe("client-side album pairing", () => {
  it("pairs by case-insensitive filename stem", () => {
    expect(albumFileKey("Night.Final.JPG")).toBe("night.final");
    const result = pairAlbumFileSelections(
      [{ name: "Night.JPG" }, { name: "Day.webp" }],
      [{ name: "NIGHT.avif" }],
    );
    expect(result.errors).toEqual([]);
    expect(result.pairs.map((pair) => [pair.key, pair.hdr?.name ?? null])).toEqual([
      ["night", "NIGHT.avif"],
      ["day", null],
    ]);
  });

  it("reports duplicate and orphan files before upload", () => {
    const result = pairAlbumFileSelections(
      [{ name: "same.jpg" }, { name: "SAME.png" }],
      [{ name: "orphan.avif" }],
    );
    expect(result.errors.join(" ")).toMatch(/重复/);
    expect(result.errors.join(" ")).toMatch(/没有同名 SDR/);
  });
});
