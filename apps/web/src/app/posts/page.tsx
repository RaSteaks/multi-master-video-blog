import Link from "next/link";
import { assetUrl, getPosts } from "@/lib/directus";

export default async function PostsPage() {
  const posts = await getPosts();

  return (
    <main className="shell page-stack">
      <header className="page-header">
        <p className="eyebrow">Articles</p>
        <h1>Posts</h1>
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
                    Article
                  </div>
                )}
                <div>
                  <p className="meta-line">{post.category || "Article"}</p>
                  <h2>{post.title}</h2>
                  <p>{post.summary || "No summary yet."}</p>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="empty-state" role="status">
          No posts have been created yet.
        </div>
      )}
    </main>
  );
}
