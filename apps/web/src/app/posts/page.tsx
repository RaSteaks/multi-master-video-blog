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
        <Link className="page-action-link" href="/write">
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
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />
          </svg>
          写文章
        </Link>
      </header>

      {posts.length > 0 ? (
        <div className="content-grid">
          {posts.map((post) => {
            const cover = assetUrl(post.cover_image);

            return (
              <Link
                className="content-card"
                href={`/posts/${post.slug}`}
                key={post.id}
                aria-label={`${post.title} — ${post.category || "Article"}`}
              >
                {cover ? (
                  <img
                    alt={`Cover image for ${post.title}`}
                    src={cover}
                    loading="lazy"
                  />
                ) : (
                  <div className="media-placeholder" aria-hidden="true">
                    文章
                  </div>
                )}
                <div>
                  <p className="meta-line">{post.category || "Article"}</p>
                  <h2>{post.title}</h2>
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
