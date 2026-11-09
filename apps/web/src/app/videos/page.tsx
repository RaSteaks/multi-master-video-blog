import Image from "next/image";
import Link from "next/link";
import { ListHeader } from "@/components/ListHeader";
import { MediaCard } from "@/components/MediaCard";
import { SortableGrid } from "@/components/SortableGrid";
import { assetUrl, getVideoProjects } from "@/lib/directus";

export default async function VideosPage() {
  const videos = await getVideoProjects();

  return (
    <main className="shell page-stack">
      <ListHeader eyebrow="视频库" title="视频与作品集" />

      {videos.length > 0 ? (
        <SortableGrid section="videos" label="视频作品" className="content-grid"
          items={videos.map((video, index) => {
            const cover = assetUrl(video.cover_image, "content-card");
            const masterCount = video.masters?.length || 0;

            return { id: video.id, title: video.title, content: (
              <Link
                className="content-card"
                href={`/videos/${video.slug}`}
                aria-label={`${video.title} — ${masterCount} master${masterCount !== 1 ? "s" : ""}`}
              >
                <MediaCard
                  morphTitle
                  meta={`${video.category || "Video"} · ${masterCount} master${masterCount !== 1 ? "s" : ""}`}
                  title={video.title}
                  description={video.description || "No description yet."}
                  media={cover ? (
                    <Image
                      data-vt="cover"
                      alt={`Cover image for ${video.title}`}
                      src={cover}
                      width={960}
                      height={540}
                      unoptimized
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
            ) };
          })} />
      ) : (
        <div className="empty-state" role="status">
          暂无视频内容。
        </div>
      )}
    </main>
  );
}
