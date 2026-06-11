import { notFound } from "next/navigation";
import { AnalyticsTracker } from "@/components/AnalyticsTracker";
import { MediaPlayer } from "@/components/MediaPlayer";
import { assetUrl, getVideoProject } from "@/lib/directus";
import { siteConfig } from "@/lib/site-config";

type VideoPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export async function generateMetadata({ params }: VideoPageProps) {
  const { slug } = await params;
  const video = await getVideoProject(slug);
  if (!video) return {};
  return {
    title: `${video.title} — ${siteConfig.title}`,
    description: video.description || video.title,
    openGraph: {
      title: video.title,
      description: video.description || undefined,
      type: "video.other" as const,
      images: video.cover_image ? [assetUrl(video.cover_image)!] : [],
    },
  };
}

export default async function VideoPage({ params }: VideoPageProps) {
  const { slug } = await params;
  const video = await getVideoProject(slug);

  if (!video) {
    notFound();
  }

  const poster = assetUrl(video.cover_image);
  const masterCount = video.masters?.length || 0;

  return (
    <main className="shell page-stack">
      <AnalyticsTracker itemType="video" itemId={video.id} />
      <header className="page-header video-title">
        <div>
          <p className="eyebrow">{video.category || "Video"}</p>
          <h1>{video.title}</h1>
        </div>
        {video.description ? (
          <p className="summary">{video.description}</p>
        ) : null}
      </header>

      <p className="meta-line">
        {masterCount} video master{masterCount !== 1 ? "s" : ""}
        {video.tags?.length ? <> · {video.tags.join(", ")}</> : null}
      </p>

      <MediaPlayer masters={video.masters || []} poster={poster} videoProjectId={video.id} />
    </main>
  );
}
