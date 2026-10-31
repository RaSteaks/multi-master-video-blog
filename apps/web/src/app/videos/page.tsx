import Link from "next/link";
import { ListHeader } from "@/components/ListHeader";
import { MediaCard } from "@/components/MediaCard";
import { assetUrl, getVideoProjects } from "@/lib/directus";

export default async function VideosPage() {
  const videos = await getVideoProjects();

  return (
    <main className="shell page-stack">
      <ListHeader eyebrow="视频库" title="视频与作品集" />

      {videos.length > 0 ? (
        <div className="content-grid">
          {videos.map((video, index) => {
            const cover = assetUrl(video.cover_image, "content-card");
            const masterCount = video.masters?.length || 0;

            return (
              <Link
                className="content-card"
                href={`/videos/${video.slug}`}
                key={video.id}
                aria-label={`${video.title} — ${masterCount} master${masterCount !== 1 ? "s" : ""}`}
              >
                <MediaCard
                  morphTitle
                  meta={`${video.category || "Video"} · ${masterCount} master${masterCount !== 1 ? "s" : ""}`}
                  title={video.title}
                  description={video.description || "No description yet."}
                  media={cover ? (
                    <img
                      data-vt="cover"
                      alt={`Cover image for ${video.title}`}
                      src={cover}
                      width={960}
                      height={540}
                      loading={index < 3 ? "eager" : "lazy"}
                      fetchPriority={index === 0 ? "high" : "auto"}
                      decoding="async"
                    />
                  ) : (
                    <div className="media-placeholder" aria-hidden="true">
                      视频
                    </div>
                  )}
                />
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
