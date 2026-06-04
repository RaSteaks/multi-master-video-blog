import { notFound } from "next/navigation";
import { MediaPlayer } from "@/components/MediaPlayer";
import { assetUrl, getVideoProject } from "@/lib/directus";

type VideoPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

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
      <header className="page-header video-title">
        <div>
          <p className="eyebrow">{video.category || "Video"}</p>
          <h1>{video.title}</h1>
        </div>
        {video.description ? (
          <p className="summary">{video.description}</p>
        ) : null}
      </header>

      <p className="meta-line" style={{ marginTop: -36 }}>
        {masterCount} video master{masterCount !== 1 ? "s" : ""}
        {video.tags?.length ? <> · {video.tags.join(", ")}</> : null}
      </p>

      <MediaPlayer masters={video.masters || []} poster={poster} />
    </main>
  );
}
