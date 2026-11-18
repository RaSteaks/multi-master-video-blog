import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

// Use preview syntax and source positions so examples in code/math and ordinary links stay literal.
export function markdownImageReferences(content: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(content);
  const definitions = new Map<string, { url: string; title?: string | null }>();
  visit(tree, "definition", node => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const references: { url: string; title?: string | null; alt: string; start: number; end: number }[] = [];
  visit(tree, node => {
    if (node.type !== "image" && node.type !== "imageReference") return;
    const target = node.type === "image" ? node : definitions.get(node.identifier);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (target && start !== undefined && end !== undefined)
      references.push({ url: target.url, title: target.title, alt: node.alt ?? "", start, end });
  });
  return references;
}
