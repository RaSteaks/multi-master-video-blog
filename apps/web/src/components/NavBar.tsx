"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
    href: "/project",
    activeHrefs: ["/project"],
    label: "实验室",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 8h18M8 12l-3 3 3 3M16 12l3 3-3 3" />
    </svg>,
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

const PENDING_RESET_MS = 10_000;

function isActive(activeHrefs: string[], pathname: string) {
  return activeHrefs.some((activeHref) => pathname.startsWith(activeHref));
}

export function NavBar() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const readyRef = useRef(false);
  // The link the user just clicked. The pill moves there at once instead of
  // waiting for the route to commit; cleared when the pathname changes.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [committedPathname, setCommittedPathname] = useState(pathname);
  if (pathname !== committedPathname) {
    setCommittedPathname(pathname);
    setPendingHref(null);
  }

  const targetHref =
    pendingHref ??
    NAV_LINKS.find(({ activeHrefs }) => isActive(activeHrefs, pathname))?.href ??
    null;

  useEffect(() => {
    // The page transition intercepts link clicks in the capture phase and
    // stops them, so React's onClick never fires; observe them here instead.
    function onClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (!anchor || !navRef.current?.contains(anchor)) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;
      const link = NAV_LINKS.find(({ href }) => href === url.pathname);
      if (link) setPendingHref(link.href);
    }
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!pendingHref) return;
    // A cancelled navigation never changes the pathname; do not strand the pill.
    const timer = window.setTimeout(() => setPendingHref(null), PENDING_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [pendingHref]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;

    function place() {
      if (!nav || !pill) return;
      const target = targetHref
        ? nav.querySelector<HTMLAnchorElement>(`a[href="${targetHref}"]`)
        : null;
      // Hidden header (home page) measures 0; wait for the ResizeObserver.
      if (!target || target.offsetWidth === 0) {
        pill.dataset.visible = "false";
        return;
      }
      pill.style.setProperty("--pill-x", `${target.offsetLeft}px`);
      pill.style.setProperty("--pill-w", `${target.offsetWidth}px`);
      pill.dataset.visible = "true";
      target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (!readyRef.current) {
        // Enable the slide only after the first placement, so the pill does
        // not fly in from x = 0 on load.
        readyRef.current = true;
        requestAnimationFrame(() => {
          pill.dataset.ready = "true";
        });
      }
    }

    place();
    const observer = new ResizeObserver(place);
    observer.observe(nav);
    nav.querySelectorAll("a").forEach((link) => observer.observe(link));
    document.fonts?.ready.then(place);
    return () => observer.disconnect();
  }, [targetHref]);

  return (
    <nav aria-label="主要导航" ref={navRef}>
      <span ref={pillRef} className="nav-pill" aria-hidden="true" />
      {NAV_LINKS.map(({ href, activeHrefs, label, icon }) => (
        <Link
          key={href}
          href={href}
          // Fetch dynamic content too, not just a loading boundary: the route
          // wipe needs the destination ready before taking its new snapshot.
          prefetch
          data-active={href === targetHref ? "true" : undefined}
          aria-current={isActive(activeHrefs, pathname) ? "page" : undefined}
        >
          {icon}
          {label}
        </Link>
      ))}
    </nav>
  );
}
