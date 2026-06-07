import type { CSSProperties } from "react";
import Link from "next/link";
import { LiquidBackground } from "@/components/LiquidBackground";
import { getCounts } from "@/lib/directus";
import {
  homeLayout,
  type HomeWidgetLayout,
} from "@/lib/home-layout";
import { siteConfig } from "@/lib/site-config";

type UploadWidgetProps = {
  className: string;
  href: string;
  layout?: HomeWidgetLayout;
  title: string;
};

type HomeWidgetStyle = CSSProperties & Record<`--${string}`, string | number>;

export default async function Home() {
  const { posts: postCount, videos: videoCount } = await getCounts();

  return (
    <>
      <LiquidBackground variant="teal" />

      <main className="orbital-home" aria-label={siteConfig.home.profileName}>
        <div
          className="orbital-stage"
          style={{ "--home-stage-height": homeLayout.stage.minHeight } as HomeWidgetStyle}
        >
          <ProfileHub layout={homeLayout.widgets.profileHub} titleId="home-title" />
          <CollectionCard
            layout={homeLayout.widgets.collection}
            postCount={postCount}
            videoCount={videoCount}
          />

          <div className="home-action-row">
            <UploadWidget
              className="floating-widget home-free-widget orbit-card orbit-upload orbit-blog-upload"
              href="/upload"
              layout={homeLayout.widgets.uploadBlog}
              title="Upload Blog"
            />

            <UploadWidget
              className="floating-widget home-free-widget orbit-card orbit-upload orbit-post-upload"
              href={siteConfig.home.postUploadHref}
              layout={homeLayout.widgets.writePost}
              title="写文章"
            />

            <GitHubWidget layout={homeLayout.widgets.github} />
          </div>
        </div>
      </main>
    </>
  );
}

function ProfileHub({
  className = "",
  layout,
  titleId,
}: {
  className?: string;
  layout?: HomeWidgetLayout;
  titleId: string;
}) {
  return (
    <section
      className={`floating-widget profile-hub${layout ? " home-free-widget" : ""}${className ? ` ${className}` : ""}`}
      style={layout ? homeWidgetStyle(layout) : undefined}
      aria-label="Personal introduction"
    >
      <div className="profile-avatar">
        {siteConfig.home.avatarUrl ? (
          <img src={siteConfig.home.avatarUrl} alt={`${siteConfig.home.profileName} avatar`} />
        ) : (
          <span>{siteConfig.home.profileInitials}</span>
        )}
      </div>

      <h1 id={titleId}>{siteConfig.home.profileName}</h1>
      <p className="profile-role">{siteConfig.home.profileRole}</p>
      <p className="summary">{siteConfig.home.profileBio}</p>
    </section>
  );
}

function CollectionCard({
  className = "",
  layout,
  postCount,
  videoCount,
}: {
  className?: string;
  layout?: HomeWidgetLayout;
  postCount: number;
  videoCount: number;
}) {
  return (
    <section
      className={`floating-widget orbit-card orbit-collection${layout ? " home-free-widget" : ""}${className ? ` ${className}` : ""}`}
      style={layout ? homeWidgetStyle(layout) : undefined}
      aria-label="Personal collection"
    >
      <p className="orbit-eyebrow">{siteConfig.home.collectionEyebrow}</p>
      <h2>{siteConfig.home.collectionTitle}</h2>
      <p>{siteConfig.home.collectionSummary}</p>
      <div className="collection-links">
        <Link href="/videos">
          <span>{siteConfig.home.collectionBlogLabel}</span>
          <strong>{videoCount}</strong>
        </Link>
        <Link href="/posts">
          <span>{siteConfig.home.collectionPostLabel}</span>
          <strong>{postCount}</strong>
        </Link>
        <Link href="/about">
          <span>{siteConfig.home.collectionAboutLabel}</span>
          <strong>{siteConfig.home.collectionAboutValue}</strong>
        </Link>
      </div>
    </section>
  );
}

function UploadWidget({ className, href, layout, title }: UploadWidgetProps) {
  const isExternal = href.startsWith("http");
  const content = <strong>{title}</strong>;
  const style = layout ? homeWidgetStyle(layout) : undefined;

  if (isExternal) {
    return (
      <a className={className} href={href} style={style} target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }

  return (
    <Link className={className} href={href} style={style}>
      {content}
    </Link>
  );
}

function GitHubWidget({
  className = "floating-widget home-free-widget github-widget",
  layout,
}: {
  className?: string;
  layout?: HomeWidgetLayout;
}) {
  return (
    <a
      className={className}
      href={siteConfig.home.githubUrl}
      style={layout ? homeWidgetStyle(layout) : undefined}
      target="_blank"
      rel="noreferrer"
      aria-label="Open GitHub profile"
    >
      <GithubIcon />
      <span>GitHub</span>
    </a>
  );
}

function homeWidgetStyle(layout: HomeWidgetLayout) {
  const style: HomeWidgetStyle = {
    "--x": layout.x,
    "--y": layout.y,
  };

  setCssVar(style, "--w", layout.w);
  setCssVar(style, "--h", layout.h);
  setCssVar(style, "--min-w", layout.minW);
  setCssVar(style, "--max-w", layout.maxW);
  setCssVar(style, "--min-h", layout.minH);
  setCssVar(style, "--max-h", layout.maxH);
  setCssVar(style, "--dx", layout.dx);
  setCssVar(style, "--dy", layout.dy);
  setCssVar(style, "--widget-padding", layout.padding);
  setCssVar(style, "--widget-font-size", layout.fontSize);
  setCssVar(style, "--widget-radius", layout.radius);
  setCssVar(style, "--widget-gap", layout.gap);
  setCssVar(style, "--widget-z", layout.zIndex);

  return style;
}

function setCssVar(
  style: HomeWidgetStyle,
  name: `--${string}`,
  value: string | number | undefined
) {
  if (value !== undefined) {
    style[name] = value;
  }
}

function GithubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.54 2.87 8.39 6.84 9.75.5.1.68-.22.68-.49 0-.24-.01-1.04-.01-1.89-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05A9.4 9.4 0 0 1 12 6.99c.85 0 1.7.12 2.5.35 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.46.1 2.72.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.15 10.15 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
