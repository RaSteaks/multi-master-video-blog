import Link from "next/link";
import { assetUrl, getVideoProjects } from "@/lib/directus";

export default async function VideosPage() {
  const videos = await getVideoProjects();

  return (
    <main className="shell page-stack">
      <header className="page-header list-page-header">
        <div>
          <p className="eyebrow">视频库</p>
          <h1>视频与作品集</h1>
        </div>
        <Link className="page-action-link" href="/upload">
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          上传视频
        </Link>
      </header>

      {videos.length > 0 ? (
        <div className="content-grid">
          {videos.map((video) => {
            const cover = assetUrl(video.cover_image);
            const masterCount = video.masters?.length || 0;

            return (
              <Link
                className="content-card"
                href={`/videos/${video.slug}`}
                key={video.id}
                aria-label={`${video.title} — ${masterCount} master${masterCount !== 1 ? "s" : ""}`}
              >
                {cover ? (
                  <img
                    alt={`Cover image for ${video.title}`}
                    src={cover}
                    loading="lazy"
                  />
                ) : (
                  <div className="media-placeholder" aria-hidden="true">
                    视频
                  </div>
                )}
                <div>
                  <p className="meta-line">
                    {video.category || "Video"} · {masterCount} master
                    {masterCount !== 1 ? "s" : ""}
                  </p>
                  <h2>{video.title}</h2>
                  <p>{video.description || "No description yet."}</p>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="empty-state" role="status">
          暂无视频内容。
        </div>
      )}
    </main>
  );
}
