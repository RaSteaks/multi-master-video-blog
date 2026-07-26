"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const animatedSections = new Set([
  "home",
  "videos",
  "posts",
  "write",
  "upload",
  "about",
]);
const pendingClass = "route-transition-pending";

const TRANSITION_RECOVERY_TIMEOUT_MS = 15_000;

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const timeoutRef = useRef<number | null>(null);
  const section = pathname.split("/").filter(Boolean)[0] || "home";
  const animateRoute = animatedSections.has(section);

  useEffect(() => {
    clearPending(timeoutRef.current);
    timeoutRef.current = null;
    setNavigationPending(false);
  }, [pathname]);

  useEffect(() => {
    function clearTransition() {
      clearPending(timeoutRef.current);
      timeoutRef.current = null;
      setNavigationPending(false);
    }

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

      setNavigationPending(true);
      clearPending(timeoutRef.current);
      // Path changes are the source of truth for completion. This timeout only
      // recovers from a cancelled or failed navigation that emits no route update.
      timeoutRef.current = window.setTimeout(() => {
        clearTransition();
      }, TRANSITION_RECOVERY_TIMEOUT_MS);
    }

    // Listen at the end of the bubbling phase. The editor's unsaved-change
    // guard stops cancelled navigations before they can reach this handler.
    window.addEventListener("click", onClick);
    window.addEventListener("pageshow", clearTransition);

    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("pageshow", clearTransition);
      clearTransition();
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

  if (url.pathname === window.location.pathname) {
    return false;
  }

  if (anchor.hasAttribute('download')) {
    return false;
  }

  return true;
}

function clearPending(timeout: number | null) {
  if (timeout != null) {
    window.clearTimeout(timeout);
  }
}

function setNavigationPending(pending: boolean) {
  document.documentElement.classList.toggle(pendingClass, pending);
  document
    .getElementById("main-content")
    ?.toggleAttribute("aria-busy", pending);
}
