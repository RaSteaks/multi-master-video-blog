export default function AboutPage() {
  return (
    <main className="shell article-shell">
      <header className="page-header">
        <p className="eyebrow">About</p>
        <h1>About This Site</h1>
        <p className="summary">
          A self-hosted media blog for articles, video projects, HLS playback,
          and multi-master HDR workflows — built for creators who care about
          image quality.
        </p>
      </header>

      <article className="markdown-body">
        <h2>What This Is</h2>
        <p>
          Multi Master Video Blog is a self-hosted platform running on a
          Windows server. It supports article publishing, HLS adaptive
          streaming, and side-by-side comparison of multiple video masters
          — SDR, HDR10, HLG, and Dolby Vision.
        </p>

        <h2>Tech Stack</h2>
        <ul>
          <li>Next.js + React for the frontend</li>
          <li>Directus CMS for content management</li>
          <li>Node.js upload API with ffmpeg transcoding</li>
          <li>Shaka Player for browser-based HLS playback</li>
          <li>Nginx reverse proxy with HTTPS</li>
        </ul>

        <h2>Contact</h2>
        <p>
          This is a personal project. Reach out through the usual channels.
        </p>
      </article>
    </main>
  );
}
