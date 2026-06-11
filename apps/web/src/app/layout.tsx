import type { Metadata } from "next";
import Link from "next/link";
import { NavBar } from "@/components/NavBar";
import { PageTransition } from "@/components/PageTransition";
import { assetUrl, getSiteSettings } from "@/lib/directus";
import { siteConfig } from "@/lib/site-config";
import "./globals.css";

export const metadata: Metadata = {
  title: siteConfig.title,
  description: siteConfig.description,
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  icons: {
    icon: "/icon.png",
    shortcut: "/favicon.ico",
    apple: "/apple-icon.png",
  },
  openGraph: {
    title: siteConfig.title,
    description: siteConfig.description,
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const settings = await getSiteSettings();
  const bgUrl = assetUrl(settings?.background_image ?? null);
  const blur = settings?.background_blur ?? 8;

  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body>
        {bgUrl ? (
          <div
            className="site-bg"
            style={{
              backgroundImage: `url(${bgUrl})`,
              "--site-bg-blur": `${blur}px`,
            } as React.CSSProperties}
            aria-hidden="true"
          />
        ) : null}

        <a href="#main-content" className="skip-link">
          Skip to content
        </a>

        <header className="site-header" role="banner">
          <Link className="brand" href="/" aria-label={`${siteConfig.title} - Home`}>
            {siteConfig.title}
          </Link>
          <NavBar />
        </header>

        <div id="main-content" tabIndex={-1}>
          <PageTransition>{children}</PageTransition>
        </div>
      </body>
    </html>
  );
}
