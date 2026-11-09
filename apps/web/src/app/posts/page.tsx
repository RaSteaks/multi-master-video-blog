import Image from "next/image";
import Link from "next/link";
import { ListHeader } from "@/components/ListHeader";
import { MediaCard } from "@/components/MediaCard";
import { SortableGrid } from "@/components/SortableGrid";
import { assetUrl, getPosts } from "@/lib/directus";

export default async function PostsPage() {
  const posts = await getPosts();

  return (
    <main className="shell page-stack glass-cards">
      <ListHeader eyebrow="记录探索技术的路程" title="文章" />

      {posts.length > 0 ? (
        <SortableGrid section="posts" label="文章" className="content-grid"
          items={posts.map((post, index) => {
            const cover = assetUrl(post.cover_image, "content-card");

            return { id: post.id, title: post.title, content: (
              <Link
                className="content-card"
                href={`/posts/${post.slug}`}
                aria-label={`${post.title} — ${post.category || "Article"}`}
              >
                <MediaCard
                  morphTitle
                  meta={post.category || "Article"}
                  title={post.title}
                  media={cover ? (
                    <Image
                      data-vt="cover"
                      alt={`Cover image for ${post.title}`}
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
                      文章
                    </div>
                  )}
                />
              </Link>
            ) };
          })} />
      ) : (
        <div className="empty-state" role="status">
          暂无文章内容。
        </div>
      )}
    </main>
  );
}
