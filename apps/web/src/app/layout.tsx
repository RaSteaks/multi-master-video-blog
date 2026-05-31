import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Multi Master Video Blog",
  description: "Self-hosted media blog with HLS playback and multi-master video switching.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  openGraph: {
    title: "Multi Master Video Blog",
    description: "Self-hosted media blog with HLS playback and multi-master video switching.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>

        <header className="site-header" role="banner">
          <Link className="brand" href="/" aria-label="Multi Master Video Blog — Home">
            Multi Master Video Blog
          </Link>
          <nav aria-label="Primary navigation">
            <Link href="/videos">Videos</Link>
            <Link href="/posts">Posts</Link>
            <Link href="/upload">Upload</Link>
            <Link href="/about">About</Link>
          </nav>
        </header>

        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
