import { readFile } from "node:fs/promises";
import path from "node:path";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { siteConfig } from "@/lib/site-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

export default async function AboutPage() {
  const about = await readAboutMarkdown();

  return (
    <main className="shell article-shell">
      <header className="page-header">
        <p className="eyebrow">{about.eyebrow}</p>
        <h1>{about.title}</h1>
        {about.summary ? <p className="summary">{about.summary}</p> : null}
      </header>

      <article className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{about.content}</ReactMarkdown>
      </article>
    </main>
  );
}

async function readAboutMarkdown(): Promise<AboutMarkdown> {
  try {
    return parseAboutMarkdown(await readFile(ABOUT_MARKDOWN_PATH, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  try {
    return parseAboutMarkdown(await readFile(ABOUT_EXAMPLE_MARKDOWN_PATH, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

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

function parseAboutMarkdown(markdown: string): AboutMarkdown {
  const { frontmatter, content } = splitFrontmatter(markdown);

  return {
    eyebrow: frontmatter.eyebrow || siteConfig.about.eyebrow,
    title: frontmatter.title || siteConfig.about.title,
    summary: frontmatter.summary || siteConfig.about.summary,
    content: content.trim() || fallbackContent(),
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
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    entries[key] = rawValue.replace(/^["']|["']$/g, "");
  }

  return entries;
}

function fallbackContent() {
  return [
    `## ${siteConfig.about.whatTitle}`,
    siteConfig.about.whatBody,
    `## ${siteConfig.about.techTitle}`,
    ...siteConfig.about.techStack.map((item) => `- ${item}`),
    `## ${siteConfig.about.contactTitle}`,
    siteConfig.about.contactBody,
  ].join("\n\n");
}
