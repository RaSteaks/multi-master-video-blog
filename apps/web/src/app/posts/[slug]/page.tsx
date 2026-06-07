import { notFound } from "next/navigation";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { assetUrl, getPost } from "@/lib/directus";
import { siteConfig } from "@/lib/site-config";

type PostPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

type TocItem = {
  id: string;
  level: number;
  text: string;
};

export async function generateMetadata({ params }: PostPageProps) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};
  return {
    title: `${post.title} — ${siteConfig.title}`,
    description: post.content?.replace(/[#*`>_[\]]/g, "").slice(0, 160) || post.title,
    openGraph: {
      title: post.title,
      type: "article" as const,
      images: post.cover_image ? [assetUrl(post.cover_image)!] : [],
    },
  };
}

export default async function PostPage({ params }: PostPageProps) {
  const { slug } = await params;
  const post = await getPost(slug);

  if (!post) {
    notFound();
  }

  const content = post.content || "";
  const tocItems = extractTocItems(content);
  const hasToc = tocItems.length > 0;
  const coverImageUrl = assetUrl(post.cover_image);
  const markdownComponents = createMarkdownComponents();

  return (
    <main className={hasToc ? "shell article-shell article-shell-with-toc" : "shell article-shell"}>
      <header className="page-header">
        <p className="eyebrow">{post.category || "Article"}</p>
        <h1>{post.title}</h1>
      </header>

      {coverImageUrl && !hasToc ? (
        <img
          className="hero-media"
          src={coverImageUrl}
          alt={`Cover image for ${post.title}`}
          loading="lazy"
        />
      ) : null}

      <div className={hasToc ? "article-content-grid" : undefined}>
        <article className="markdown-body">
          <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
            {content}
          </ReactMarkdown>
        </article>

        {hasToc ? (
          <aside className="article-toc" aria-label="Article table of contents">
            {coverImageUrl ? (
              <img
                className="article-toc-cover"
                src={coverImageUrl}
                alt={`Cover image for ${post.title}`}
                loading="lazy"
              />
            ) : null}
            <p>{siteConfig.articleTocLabel}</p>
            <nav>
              {tocItems.map((item) => (
                <a
                  className={`article-toc-level-${item.level}`}
                  href={`#${item.id}`}
                  key={item.id}
                >
                  {item.text}
                </a>
              ))}
            </nav>
          </aside>
        ) : null}
      </div>
    </main>
  );
}

function createMarkdownComponents(): Components {
  const slugHeading = createSlugger();

  return {
    h1: headingComponent("h1", 1, slugHeading),
    h2: headingComponent("h2", 2, slugHeading),
    h3: headingComponent("h3", 3, slugHeading),
    h4: headingComponent("h4", 4, slugHeading),
    h5: headingComponent("h5", 5, slugHeading),
    h6: headingComponent("h6", 6, slugHeading),
  };
}

function headingComponent(
  Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6",
  level: number,
  slugHeading: (text: string) => string
) {
  return function Heading({
    children,
    ...props
  }: ComponentPropsWithoutRef<typeof Tag>) {
    const text = textFromChildren(children);
    const id = slugHeading(text || `heading-${level}`);

    return (
      <Tag id={id} {...props}>
        {children}
      </Tag>
    );
  };
}

function extractTocItems(markdown: string): TocItem[] {
  const slugHeading = createSlugger();
  const items: TocItem[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      const length = fenceMatch[1].length;

      if (!fence) {
        fence = { marker, length };
        continue;
      }

      if (fence.marker === marker && length >= fence.length) {
        fence = null;
      }

      continue;
    }

    if (fence) continue;

    const headingMatch = line.match(/^ {0,3}(#{1,6})(?:\s+|$)(.*)$/);
    if (!headingMatch) continue;

    const level = headingMatch[1].length;
    const text = cleanHeadingText(headingMatch[2]);
    if (!text) continue;

    items.push({
      id: slugHeading(text),
      level,
      text,
    });
  }

  return items;
}

function cleanHeadingText(value: string) {
  return value
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textFromChildren(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map(textFromChildren).join("");
  }

  if (
    children &&
    typeof children === "object" &&
    "props" in children &&
    typeof children.props === "object" &&
    children.props &&
    "children" in children.props
  ) {
    return textFromChildren(children.props.children as ReactNode);
  }

  return "";
}

function createSlugger() {
  const seen = new Map<string, number>();

  return (text: string) => {
    const base =
      text
        .toLowerCase()
        .trim()
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "section";
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);

    return count === 0 ? base : `${base}-${count + 1}`;
  };
}
