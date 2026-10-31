import { describe, expect, it } from "vitest";
import { classifyDroppedFiles } from "./dropped-files";

describe("author file routing", () => {
  const file = (name: string, type = "") => ({ name, type });
  it("routes each supported workflow without depending on browser MIME guesses", () => {
    expect(classifyDroppedFiles([file("master.MOV")], true)).toBe("video");
    expect(classifyDroppedFiles([file("frame.JPG"), file("frame.AVIF"), file("other.heif")], true)).toBe("photo");
    expect(classifyDroppedFiles([file("roll.TIFF")], true)).toBe("film");
    expect(classifyDroppedFiles([file("article.md", "text/markdown")], true)).toBe("article");
  });
  it("rejects mixed workflows, unknown files, multiple articles and production film import", () => {
    for (const files of [[file("a.mp4"), file("b.png")], [file("a.exe")], [file("a.md"), file("b.md")], []]) {
      expect(() => classifyDroppedFiles(files, true)).toThrow();
    }
    expect(() => classifyDroppedFiles([file("roll.tif")], false)).toThrow();
  });
});
