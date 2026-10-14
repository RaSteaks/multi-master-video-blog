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
      images: video.cover_image ? [assetUrl(video.cover_image, "content-hero")!] : [],
    },
  };
}

export default async function VideoPage({ params }: VideoPageProps) {
  const { slug } = await params;
  const video = await getVideoProject(slug);

  if (!video) {
    notFound();
  }

  const poster = assetUrl(video.cover_image, "content-hero");
  const masterCount = video.masters?.length || 0;

  return (
    <main className="shell page-stack">
      <AnalyticsTracker itemType="video" itemId={video.id} />
      <header className="page-header video-title">
        <p className="eyebrow">{video.category || "Video"}</p>
        <h1 data-vt="title">{video.title}</h1>
        {video.description ? (
          <p className="summary">{video.description}</p>
        ) : null}
        <p className="meta-line">
          {masterCount} video master{masterCount !== 1 ? "s" : ""}
          {video.tags?.length ? <> · {video.tags.join(", ")}</> : null}
        </p>
      </header>

      {/* Bind follow-up uploads to this project's stable ID instead of re-entering its metadata. */}
      <MediaPlayer
        masters={video.masters || []}
        poster={poster}
        videoProjectId={video.id}
        addMaster={{
          href: `/upload?projectId=${video.id}`,
          label: video.masters?.some(master => master.type === "sdr") ? "添加母版" : "补充 SDR 母版",
        }}
      />
    </main>
  );
}
