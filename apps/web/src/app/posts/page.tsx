import Link from "next/link";
import { assetUrl, getPosts } from "@/lib/directus";

export default async function PostsPage() {
  const posts = await getPosts();

  return (
    <main className="shell page-stack glass-cards">
      <header className="page-header list-page-header">
        <div>
          <p className="eyebrow">记录探索技术的路程</p>
          <h1>文章</h1>
        </div>
      </header>

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
                {cover ? (
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
                <div>
                  <p className="meta-line">{post.category || "Article"}</p>
                  <h2 data-vt="title">{post.title}</h2>
                </div>
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
