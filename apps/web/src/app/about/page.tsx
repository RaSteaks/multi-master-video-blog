import { siteConfig } from "@/lib/site-config";

export default function AboutPage() {
  return (
    <main className="shell article-shell">
      <header className="page-header">
        <p className="eyebrow">{siteConfig.about.eyebrow}</p>
        <h1>{siteConfig.about.title}</h1>
        <p className="summary">{siteConfig.about.summary}</p>
      </header>

      <article className="markdown-body">
        <h2>{siteConfig.about.whatTitle}</h2>
        <p>{siteConfig.about.whatBody}</p>

        <h2>{siteConfig.about.techTitle}</h2>
        <ul>
          {siteConfig.about.techStack.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <h2>{siteConfig.about.contactTitle}</h2>
        <p>{siteConfig.about.contactBody}</p>
      </article>
    </main>
  );
}
