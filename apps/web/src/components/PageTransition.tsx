"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
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

/**
 * Slow-navigation state machine (docs/performance-optimization-plan.md §7):
 *
 *   idle          no feedback, no animation
 *   pending-fast  < SLOW_NAV_THRESHOLD_MS after click — stay silent so
 *                 prefetched/instant navigations never flash a progress bar
 *                 or pay the ~300ms enter-animation cost
 *   pending-slow  threshold exceeded — show progress bar, mark the
 *                 navigation as "should animate" for when it commits
 *   committed     pathname changed — new page plays the enter animation
 *                 only if this navigation was actually slow
 *
 * Pathname changes are the source of truth for completion. The recovery
 * timeout only clears a stuck pending state when a navigation is cancelled
 * or fails without emitting a route update.
 */

// Fast navigations stay silent; slow ones get the progress bar + enter
// animation. Initial value per plan §7.1 (test 80–120ms against real TTFB).
const SLOW_NAV_THRESHOLD_MS = 100;
const TRANSITION_RECOVERY_TIMEOUT_MS = 15_000;

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const thresholdTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  // Whether the in-flight navigation has exceeded the slow threshold. Read
  // during render when the pathname commits, reset by the cleanup effect.
  const slowNavRef = useRef(false);
  const pendingRef = useRef(false);
  const section = pathname.split("/").filter(Boolean)[0] || "home";

  // Decide the animation flag synchronously while the new page renders, so
  // `data-animate-route` is already correct on the first painted frame (an
  // effect-based flip would show the finished page for one frame, then flash
  // back into the animation's start state). Adjusting state during render is
  // React's documented pattern for deriving state from changed "props".
  const [committedPathname, setCommittedPathname] = useState(pathname);
  const [animateRoute, setAnimateRoute] = useState(false);
  if (pathname !== committedPathname) {
    setCommittedPathname(pathname);
    setAnimateRoute(slowNavRef.current && animatedSections.has(section));
  }

  useEffect(() => {
    // Navigation committed: release pending state for the next cycle.
    clearTimer(thresholdTimerRef);
    clearTimer(recoveryTimerRef);
    thresholdTimerRef.current = null;
    recoveryTimerRef.current = null;
    slowNavRef.current = false;
    pendingRef.current = false;
    setNavigationPending(false);
  }, [pathname]);

  useEffect(() => {
    function markSlowNavigation() {
      slowNavRef.current = true;
      pendingRef.current = true;
      setNavigationPending(true);
      armRecovery();
    }

    function armRecovery() {
      clearTimer(recoveryTimerRef);
      // Path changes are the source of truth for completion. This timeout only
      // recovers from a cancelled or failed navigation that emits no route
      // update.
      recoveryTimerRef.current = window.setTimeout(
        clearTransition,
        TRANSITION_RECOVERY_TIMEOUT_MS,
      );
    }

    function clearTransition() {
      clearTimer(thresholdTimerRef);
      clearTimer(recoveryTimerRef);
      thresholdTimerRef.current = null;
      recoveryTimerRef.current = null;
      slowNavRef.current = false;
      pendingRef.current = false;
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

      if (pendingRef.current) {
        // A slow navigation is already in flight (rapid successive clicks):
        // keep the slow marking and only re-arm recovery for the newest one.
        armRecovery();
        return;
      }

      clearTimer(thresholdTimerRef);
      thresholdTimerRef.current = window.setTimeout(
        markSlowNavigation,
        SLOW_NAV_THRESHOLD_MS,
      );
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

function clearTimer(timer: RefLikeTimer) {
  if (timer.current != null) {
    window.clearTimeout(timer.current);
  }
}

type RefLikeTimer = { current: number | null };

function setNavigationPending(pending: boolean) {
  document.documentElement.classList.toggle(pendingClass, pending);
  document
    .getElementById("main-content")
    ?.toggleAttribute("aria-busy", pending);
}
