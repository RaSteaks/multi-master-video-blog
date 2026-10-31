import Link from "next/link";
import { ListHeader } from "@/components/ListHeader";
import { MediaCard } from "@/components/MediaCard";
import { assetUrl, getPosts } from "@/lib/directus";

export default async function PostsPage() {
  const posts = await getPosts();

  return (
    <main className="shell page-stack glass-cards">
      <ListHeader eyebrow="记录探索技术的路程" title="文章" />

      {posts.length > 0 ? (
        <div className="content-grid">
          {posts.map((post, index) => {
            const cover = assetUrl(post.cover_image, "content-card");

            return (
              <Link
                className="content-card"
                href={`/posts/${post.slug}`}
                key={post.id}
                aria-label={`${post.title} — ${post.category || "Article"}`}
              >
                <MediaCard
                  morphTitle
                  meta={post.category || "Article"}
                  title={post.title}
                  media={cover ? (
                    <img
                      data-vt="cover"
                      alt={`Cover image for ${post.title}`}
                      src={cover}
                      width={960}
                      height={540}
                      loading={index < 3 ? "eager" : "lazy"}
                      fetchPriority={index === 0 ? "high" : "auto"}
                      decoding="async"
                    />
                  ) : (
                    <div className="media-placeholder" aria-hidden="true">
                      文章
                    </div>
                  )}
                />
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="empty-state" role="status">
          暂无文章内容。
        </div>
      )}
    </main>
  );
}
