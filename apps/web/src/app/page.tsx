import Link from "next/link";
import { LiquidBackground } from "@/components/LiquidBackground";
import { getPosts, getVideoProjects } from "@/lib/directus";

export default async function Home() {
  const [posts, videos] = await Promise.all([getPosts(100), getVideoProjects(100)]);

  const postCount = posts.length;
  const videoCount = videos.length;

  return (
    <>
      <LiquidBackground variant="teal" />

      <main className="home-hero">
        {/* ---- Hero text ---- */}
        <header className="home-hero-content">
          <p className="eyebrow">Self-hosted · HDR · Multi-master</p>
          <h1>Multi Master Video Blog</h1>
          <p className="summary">
            A cinema-grade media platform for articles, HLS video playback,
            HDR metadata, and seamless switching between SDR, HDR10, HLG, and
            Dolby Vision masters.
          </p>
        </header>

        {/* ---- Portal navigation cards ---- */}
        <div className="portal-grid">
          <Link
            className="portal-card video-card"
            href="/videos"
            aria-label={`Browse ${videoCount} video projects`}
          >
            <div className="portal-icon" aria-hidden="true">
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </div>
            <h2>Videos</h2>
            <p>Browse video projects with multi-master HLS playback</p>
            <div className="portal-stats">
              <span className="portal-stat">
                <strong>{videoCount}</strong> project{videoCount !== 1 ? "s" : ""}
              </span>
            </div>
            <span className="portal-arrow">
              View library
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </span>
          </Link>

          <Link
            className="portal-card blog-card"
            href="/posts"
            aria-label={`Read ${postCount} articles`}
          >
            <div className="portal-icon" aria-hidden="true">
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <h2>Blog</h2>
            <p>Read articles and written posts</p>
            <div className="portal-stats">
              <span className="portal-stat">
                <strong>{postCount}</strong> article{postCount !== 1 ? "s" : ""}
              </span>
            </div>
            <span className="portal-arrow">
              Read posts
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </span>
          </Link>
        </div>
      </main>
    </>
  );
}
