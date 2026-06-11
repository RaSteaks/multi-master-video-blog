import Link from "next/link";
import { assetUrl, getVideoProjects } from "@/lib/directus";

export default async function VideosPage() {
  const videos = await getVideoProjects();

  return (
    <main className="shell page-stack">
      <header className="page-header">
        <p className="eyebrow">Video Library</p>
        <h1>Video&Showreels</h1>
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
                    Video
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
          No videos have been created yet.
        </div>
      )}
    </main>
  );
}
