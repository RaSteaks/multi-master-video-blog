import { readFile } from "node:fs/promises";
import path from "node:path";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnalyticsTracker } from "@/components/AnalyticsTracker";
import { assetUrl, getPost } from "@/lib/directus";
import { siteConfig } from "@/lib/site-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ── CMS-first rendering ───────────────────────────────────────────────────────
// Looks for a post with slug "about" in Directus.
// Falls back to content/about.md if not found or CMS is unreachable.

export default async function AboutPage() {
  // 1. Try CMS
  let cmsPost = null;
  try {
    cmsPost = await getPost("about");
  } catch {
    // CMS unreachable — fall through to local file
  }

  if (cmsPost) {
    const coverUrl = assetUrl(cmsPost.cover_image);
    const bgImageUrl = assetUrl(cmsPost.backgroundimage);
    const content = cmsPost.content || "";

    return (
      <>
        <AnalyticsTracker itemType="post" itemId={cmsPost.id} />
        {bgImageUrl ? (
          <div
            className="site-bg"
            style={{ backgroundImage: `url(${bgImageUrl})`, "--site-bg-blur": "14px" } as React.CSSProperties}
            aria-hidden="true"
          />
        ) : null}
        <main className="shell article-shell">
          <div className="content-glass">
            <header className="page-header">
              <p className="eyebrow">
                {cmsPost.category || siteConfig.about.eyebrow}
              </p>
              <h1>{cmsPost.title}</h1>
            </header>

            {coverUrl ? (
              <img
                className="hero-media"
                src={coverUrl}
                alt={`Cover image for ${cmsPost.title}`}
                loading="lazy"
              />
            ) : null}

            <article className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </article>
          </div>
        </main>
      </>
    );
  }

  // 2. Fall back to local file
  const about = await readAboutMarkdown();

  return (
    <main className="shell article-shell">
      <div className="content-glass">
        <header className="page-header">
          <p className="eyebrow">{about.eyebrow}</p>
          <h1>{about.title}</h1>
          {about.summary ? <p className="summary">{about.summary}</p> : null}
        </header>

        <article className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{about.content}</ReactMarkdown>
        </article>
      </div>
    </main>
  );
}

// ── Local file fallback ───────────────────────────────────────────────────────

type AboutMarkdown = {
  eyebrow: string;
  title: string;
  summary: string;
  content: string;
};

const ABOUT_MARKDOWN_PATH = path.join(process.cwd(), "content", "about.md");
const ABOUT_EXAMPLE_MARKDOWN_PATH = path.join(
  process.cwd(),
  "content",
  "about.example.md",
);

async function readAboutMarkdown(): Promise<AboutMarkdown> {
  try {
    return parseAboutMarkdown(await readFile(ABOUT_MARKDOWN_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    return parseAboutMarkdown(
      await readFile(ABOUT_EXAMPLE_MARKDOWN_PATH, "utf8")
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return fallbackAbout();
}

function parseAboutMarkdown(markdown: string): AboutMarkdown {
  const { frontmatter, content } = splitFrontmatter(markdown);

  return {
    eyebrow: frontmatter.eyebrow || siteConfig.about.eyebrow,
    title: frontmatter.title || siteConfig.about.title,
    summary: frontmatter.summary || siteConfig.about.summary,
    content: content.trim() || fallbackAbout().content,
  };
}

function fallbackAbout(): AboutMarkdown {
  return {
    eyebrow: siteConfig.about.eyebrow,
    title: siteConfig.about.title,
    summary: siteConfig.about.summary,
    content: [
      `## ${siteConfig.about.whatTitle}`,
      siteConfig.about.whatBody,
      `## ${siteConfig.about.techTitle}`,
      ...siteConfig.about.techStack.map((item) => `- ${item}`),
      `## ${siteConfig.about.contactTitle}`,
      siteConfig.about.contactBody,
    ].join("\n\n"),
  };
}

function splitFrontmatter(markdown: string) {
  if (!markdown.startsWith("---")) {
    return { frontmatter: {}, content: markdown };
  }

  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, content: markdown };
  }

  return {
    frontmatter: parseFrontmatter(match[1]),
    content: markdown.slice(match[0].length),
  };
}

function parseFrontmatter(value: string) {
  const entries: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const raw = line.slice(sep + 1).trim();
    entries[key] = raw.replace(/^["']|["']$/g, "");
  }
  return entries;
}
