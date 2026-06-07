"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const animatedSections = new Set(["videos", "posts", "upload", "about"]);
const pendingClass = "route-transition-pending";

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const timeoutRef = useRef<number | null>(null);
  const section = pathname.split("/").filter(Boolean)[0] || "home";
  const animateRoute = animatedSections.has(section);

  useEffect(() => {
    clearPending(timeoutRef.current);
    timeoutRef.current = null;
    document.documentElement.classList.remove(pendingClass);
  }, [pathname]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (shouldIgnoreClick(event)) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest("a[href]");
      if (!anchor || !(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      if (!isInternalPageNavigation(anchor)) {
        return;
      }

      document.documentElement.classList.add(pendingClass);
      clearPending(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        document.documentElement.classList.remove(pendingClass);
        timeoutRef.current = null;
      }, 320);
    }

    document.addEventListener("click", onClick, true);

    return () => {
      document.removeEventListener("click", onClick, true);
      clearPending(timeoutRef.current);
    };
  }, []);

  return (
    <div
      key={pathname}
      className="page-transition"
      data-animate-route={animateRoute ? "true" : "false"}
      data-route-section={section}
    >
      {children}
    </div>
  );
}

function shouldIgnoreClick(event: MouseEvent) {
  return (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0 ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function isInternalPageNavigation(anchor: HTMLAnchorElement) {
  const url = new URL(anchor.href);

  if (url.origin !== window.location.origin) {
    return false;
  }

  if (anchor.target && anchor.target !== "_self") {
    return false;
  }

  if (url.pathname === window.location.pathname && url.search === window.location.search) {
    return false;
  }

  return true;
}

function clearPending(timeout: number | null) {
  if (timeout != null) {
    window.clearTimeout(timeout);
  }
}
