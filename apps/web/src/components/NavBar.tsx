"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/videos", label: "Videos" },
  { href: "/posts",  label: "Posts"  },
  { href: "/upload", label: "Upload" },
  { href: "/about",  label: "About"  },
];

export function NavBar() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary navigation">
      {NAV_LINKS.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname.startsWith(href) ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
