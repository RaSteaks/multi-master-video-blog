import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { assetUrl, getPost } from "@/lib/directus";

type PostPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export default async function PostPage({ params }: PostPageProps) {
  const { slug } = await params;
  const post = await getPost(slug);

  if (!post) {
    notFound();
  }

  const cover = assetUrl(post.cover_image);

  return (
    <main className="shell article-shell">
      <header className="page-header">
        <p className="eyebrow">{post.category || "Article"}</p>
        <h1>{post.title}</h1>
        {post.summary ? <p className="summary">{post.summary}</p> : null}
      </header>

      {cover ? (
        <img
          className="hero-media"
          alt={`Cover image for ${post.title}`}
          src={cover}
        />
      ) : null}

      <article className="markdown-body">
        <ReactMarkdown>{post.content || ""}</ReactMarkdown>
      </article>
    </main>
  );
}
