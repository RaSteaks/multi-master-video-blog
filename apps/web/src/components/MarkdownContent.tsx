import type { InlineMath } from "mdast-util-math";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "./markdown-math.css";

type MarkdownContentProps = Pick<Options, "components" | "urlTransform"> & { children: string };

export function MarkdownContent({ children, ...props }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      {...props}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      remarkRehypeOptions={{
        handlers: {
          inlineMath(_state, node: InlineMath, parent) {
            // remark-math treats same-line $$…$$ as inline. Existing posts also use it
            // for standalone equations, so preserve display sizing in that context.
            const offset = node.position?.start.offset;
            const display = parent?.type === "paragraph" && parent.children.length === 1
              && offset !== undefined && children.startsWith("$$", offset);
            return {
              type: "element",
              tagName: "code",
              properties: { className: [display ? "math-display" : "math-inline"] },
              children: [{ type: "text", value: node.value }],
            };
          },
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
