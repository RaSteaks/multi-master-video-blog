import { describe, expect, it } from "vitest";
import { readMarkdown } from "./markdown-import";

function file(path: string, content = "", type = "") {
  const file = new File([content], path.split("/").pop()!, { type });
  if (path.includes("/")) Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

describe("illustrated Markdown import", () => {
  it("matches relative to the document, decodes URL paths and reuses each selected image", async () => {
    const source = file("book/notes/post.md", [
      "![图一](../a/%E6%B5%B7%20A.png?v=2#top)",
      '![图二][other]', '![重复](<../a/海 A.png>)',
      '[other]: <../b/海 A.png> "另一张"',
    ].join("\n\n"));
    const a = file("book/a/海 A.png", "AAA", "image/png");
    const b = file("book/b/海 A.png", "BBB");
    const result = await readMarkdown([source, b, a, file("book/unused.jpg")]);
    expect(result.missing).toEqual([]);
    expect(result.images.map(image => image.file.type)).toEqual(["image/png", "image/png"]);
    expect(result.images[0].file).toBe(a);
    expect(await result.images[1].file.text()).toBe("BBB");
    expect(result.content.split(result.images[0].key)).toHaveLength(3);
    expect(result.content).toContain(`![图二](article-image://${result.images[1].key} "另一张")`);
  });

  it("only changes rendered local images, leaving links, code, math and site/remote URLs intact", async () => {
    const literal = ['`![demo](cover.png)`', '```md\n![demo](cover.png)\n```',
      '$![demo](cover.png)$', '[link](cover.png)', '![remote](https://example.org/a.png)',
      '![site](/api/assets/abc)', '![cdn](//example.org/a.png)', '![abs](file:///tmp/a.png)'].join("\n\n");
    const result = await readMarkdown([file("post.md", literal + "\n\n![yes](./cover.png)"), file("cover.png")]);
    expect(result.images).toHaveLength(1);
    expect(result.content.startsWith(literal)).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("reports missing and ambiguous paths without guessing or escaping the selected directory", async () => {
    const content = "![a](../x.png) ![b](sub/x.png) ![c](x.png) ![b](sub/x.png)";
    const result = await readMarkdown([file("post.md", content), file("x.png"), file("x.png")]);
    expect(result.images).toEqual([]);
    expect(result.missing).toEqual(["../x.png", "sub/x.png", "x.png"]);
    expect(result.content).toBe(content);
  });

  it("checks only referenced files and rejects unsupported images and excess attachments", async () => {
    await expect(readMarkdown([file("post.md", "![a](vector.svg)"), file("vector.svg")])).rejects.toThrow("图片");
    const images = Array.from({ length: 25 }, (_, i) => file(`${i}.png`));
    await expect(readMarkdown([file("post.md", images.map(f => `![](${f.name})`).join("\n")), ...images])).rejects.toThrow("24");
    const document = file("post.md", "正文");
    await expect(readMarkdown([file("other.md")], document)).rejects.toThrow("post.md");
    await expect(readMarkdown([file("root/a/post.md"), file("root/b/post.md")], document)).rejects.toThrow("同名");
  });
});
