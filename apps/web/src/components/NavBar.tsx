"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  {
    href: "/videos",
    activeHrefs: ["/videos", "/upload"],
    label: "视频",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <polygon points="10 9 15 12 10 15" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    href: "/posts",
    activeHrefs: ["/posts", "/write"],
    label: "文章",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 4h16v16H4z" rx="2" />
        <line x1="8" y1="9" x2="16" y2="9" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="12" y2="17" />
      </svg>
    ),
  },
  {
    href: "/albums",
    activeHrefs: ["/albums"],
    label: "相簿",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="9" cy="10" r="2" />
        <path d="m4 17 4-4 3 3 2-2 6 6" />
      </svg>
    ),
  },
  {
    href: "/about",
    activeHrefs: ["/about"],
    label: "关于",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    ),
  },
];

export function NavBar() {
  const pathname = usePathname();
  return (
    <nav aria-label="主要导航">
      {NAV_LINKS.map(({ href, activeHrefs, label, icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={
            activeHrefs.some((activeHref) => pathname.startsWith(activeHref))
              ? "page"
              : undefined
          }
        >
          {icon}
          {label}
        </Link>
      ))}
    </nav>
  );
}
