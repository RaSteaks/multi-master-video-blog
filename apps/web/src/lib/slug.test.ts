import { describe, expect, it } from "vitest";
import { SLUG_MAX_LENGTH, SLUG_PATTERN, sanitizeSlugInput, slugify, slugifyFileName, timestampSlug } from "./slug";

describe("slug helpers", () => {
  it("slugifies titles and file names", () => {
    expect(slugify("Black Hole — Dolby Vision!")).toBe("black-hole-dolby-vision");
    expect(slugify("Café Réel")).toBe("cafe-reel");
    expect(slugify("黑洞")).toBe("");
    expect(slugifyFileName("blackhole_dolbyvison.final.mov")).toBe("blackhole-dolbyvison-final");
  });
  it("normalizes input while typing but keeps a trailing hyphen", () => {
    expect(sanitizeSlugInput("Dolby Vision_Test")).toBe("dolby-vision-test");
    expect(sanitizeSlugInput("-dolby--")).toBe("dolby-");
    expect(sanitizeSlugInput("黑洞 hdr")).toBe("hdr");
  });
  it("caps length and always yields valid slugs", () => {
    expect(slugify("a".repeat(300)).length).toBe(SLUG_MAX_LENGTH);
    expect(SLUG_PATTERN.test(slugify("x ".repeat(200)))).toBe(true);
    expect(SLUG_PATTERN.test(timestampSlug("video", new Date("2026-10-14T08:05:00Z")))).toBe(true);
    expect(timestampSlug("video", new Date("2026-10-14T08:05:00Z"))).toBe("video-202610140805");
  });
});
