import { readFile } from "node:fs/promises";
import path from "node:path";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnalyticsTracker } from "@/components/AnalyticsTracker";
import { assetIdsFromMarkdown, assetUrl, getAssetDimensions, getPost } from "@/lib/directus";
import { markdownImageComponent } from "@/components/MarkdownImage";
import { siteConfig } from "@/lib/site-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// No loading.tsx on purpose: this page renders quickly and its layout (cover
// or not) is unknown until it does, so any skeleton would be swapped out with
// a jump. Without a loading boundary the previous page stays on screen (with
// the progress bar if slow) until the content is ready, then changes once.
// The home skeleton lives in (home)/loading.tsx so it does not wrap this route.

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
    const bgImageUrl = assetUrl(cmsPost.backgroundimage, "site-background");
    const content = cmsPost.content || "";
    // Fidelity mode (plan §5.2): the about cover keeps its original ratio —
    // no cropping preset. Real file dimensions only reserve layout space so
    // the image cannot shift the page when it loads. Missing metadata falls
    // back to attribute-free rendering (pre-existing behavior).
    const dimensions = await getAssetDimensions([
      ...assetIdsFromMarkdown(content),
      ...(cmsPost.cover_image ? [cmsPost.cover_image] : []),
    ]);
    const coverSize = cmsPost.cover_image ? dimensions.get(cmsPost.cover_image) : undefined;
    const cover = coverUrl && {
      className: "hero-media about-cover",
      src: coverUrl,
      alt: `Cover image for ${cmsPost.title}`,
      loading: "eager",
      decoding: "async",
      fetchPriority: "high",
    } as const;
    const components = { img: markdownImageComponent(dimensions) };

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
            <header className="page-header about-header">
              <p className="eyebrow">
                {cmsPost.category || siteConfig.about.eyebrow}
              </p>
              <h1>{cmsPost.title}</h1>
              <SupportEntry />
            </header>

            {cover && (coverSize
              ? <Image {...cover} {...coverSize} unoptimized />
              // eslint-disable-next-line @next/next/no-img-element -- A cover without CMS dimensions uses its original aspect ratio in normal flow.
              : <img {...cover} />)}

            <article className="markdown-body">
              <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </article>
          </div>
        </main>
      </>
    );
  }

  // 2. Fall back to local file
  const about = await readAboutMarkdown();
  const dimensions = await getAssetDimensions(assetIdsFromMarkdown(about.content));
  const components = { img: markdownImageComponent(dimensions) };

  return (
    <main className="shell article-shell">
      <div className="content-glass">
        <header className="page-header about-header">
          <p className="eyebrow">{about.eyebrow}</p>
          <h1>{about.title}</h1>
          {about.summary ? <p className="summary">{about.summary}</p> : null}
          <SupportEntry />
        </header>

        <article className="markdown-body">
          <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>{about.content}</ReactMarkdown>
        </article>
      </div>
    </main>
  );
}

/**
 * The site's playback and colour guide, set beside the title so it stays out of
 * the way of the personal introduction below it. A full document load: /support
 * is a standalone static page.
 */
function SupportEntry() {
  return (
    <a className="about-support-link" href="/support" data-native-navigation>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="2" y="4" width="20" height="14" rx="2" />
        <path d="M8 22h8M12 18v4M9 8l6 3-6 3z" />
      </svg>
      <span>
        <strong>播放与色彩支持</strong>
        <small lang="en">Playback &amp; Color</small>
      </span>
      <svg className="about-support-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </a>
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
