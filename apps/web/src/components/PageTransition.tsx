"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const animatedSections = new Set([
  "home",
  "videos",
  "posts",
  "write",
  "upload",
  "about",
  "albums",
]);
const pendingClass = "route-transition-pending";
// Route skeletons (loading.tsx) carry this marker so the veil can wait for the
// real content instead of finishing while only a skeleton is on screen.
const LOADING_SELECTOR = "[data-route-loading]";
const VEIL_DURATION_MS = 240;
const VEIL_EASING = "cubic-bezier(.22, 1, .36, 1)";

/**
 * Two independent concerns (docs/performance-optimization-plan.md §7):
 *
 * Enter animation — every route change in an animated section fades a short
 * veil out above the page (see globals.css "Enter transition"), however fast
 * the navigation was. The new page is interactive immediately; the animation
 * is only decoration. The veil plays when the *real content* appears: at once
 * if the committed route shows content, or when the loading skeleton is
 * replaced by it, so a slow load is not "used up" while only a skeleton shows.
 * Rapid successive navigations cancel the earlier veil, so only the final
 * target animates.
 *   - first load: no animation (the page is simply shown)
 *   - back/forward (popstate): no animation, so scroll restoration is instant
 *   - prefers-reduced-motion: no animation
 *   - same-page / hash-only links never change the pathname, so they neither
 *     remount nor animate
 *
 * Loading hint — only navigations that outlast SLOW_NAV_THRESHOLD_MS show the
 * progress bar and set aria-busy, so prefetched or instant navigations never
 * flash a bar.
 *   idle          no feedback
 *   pending-fast  < threshold after click — stay silent
 *   pending-slow  threshold exceeded — progress bar
 *   committed     pathname changed — hint cleared (a skeleton, if any, takes
 *                 over the remaining wait)
 *
 * Pathname changes are the source of truth for completion. The recovery
 * timeout only clears a stuck pending state when a navigation is cancelled
 * or fails without emitting a route update.
 */

// Only navigations slower than this get the progress bar. Initial
// value per plan §7.1 (test 80–120ms against real TTFB).
const SLOW_NAV_THRESHOLD_MS = 100;
const TRANSITION_RECOVERY_TIMEOUT_MS = 15_000;

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const thresholdTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  // Loading-hint state only: whether the in-flight navigation has exceeded the
  // slow threshold. It no longer decides whether the enter animation plays.
  const pendingRef = useRef(false);
  // Set by popstate (back/forward), read when the pathname commits.
  const historyNavRef = useRef(false);
  const section = pathname.split("/").filter(Boolean)[0] || "home";
  const wrapperRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);

  // Decide the animation mode synchronously while the new page renders, so
  // `data-animate-route` is already correct on the first painted frame (an
  // effect-based flip would show the finished page for one frame, then flash
  // back into the animation's start state). Adjusting state during render is
  // React's documented pattern for deriving state from changed "props".
  const [committedPathname, setCommittedPathname] = useState(pathname);
  const [animateRoute, setAnimateRoute] = useState<RouteAnimation>("false");
  if (pathname !== committedPathname) {
    setCommittedPathname(pathname);
    setAnimateRoute(routeAnimation(section, historyNavRef.current));
  }

  useLayoutEffect(() => {
    const veil = veilRef.current;
    const wrapper = wrapperRef.current;
    if (!veil || !wrapper) return;
    // A superseded navigation's veil must not keep playing over the new page.
    veil.getAnimations().forEach((animation) => animation.cancel());
    if (animateRoute !== "true") return;

    if (!wrapper.querySelector(LOADING_SELECTOR)) {
      playVeil(veil);
      return;
    }

    // Skeleton on screen: wait until the real content replaces it.
    const observer = new MutationObserver(() => {
      if (wrapper.querySelector(LOADING_SELECTOR)) return;
      observer.disconnect();
      playVeil(veil);
    });
    observer.observe(wrapper, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname, animateRoute]);

  useEffect(() => {
    // Navigation committed: release pending state for the next cycle.
    clearTimer(thresholdTimerRef);
    clearTimer(recoveryTimerRef);
    thresholdTimerRef.current = null;
    recoveryTimerRef.current = null;
    historyNavRef.current = false;
    pendingRef.current = false;
    setNavigationPending(false);
  }, [pathname]);

  useEffect(() => {
    function markSlowNavigation() {
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
      pendingRef.current = false;
      setNavigationPending(false);
    }

    function onPopState() {
      historyNavRef.current = true;
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

      // A new link navigation supersedes any earlier popstate that never
      // changed the pathname (e.g. back across a hash-only history entry).
      historyNavRef.current = false;

      if (pendingRef.current) {
        // A slow navigation is already in flight (rapid successive clicks):
        // keep the loading hint and only re-arm recovery for the newest one.
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
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pageshow", clearTransition);

    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", clearTransition);
      clearTransition();
    };
  }, []);

  return (
    <>
      <div ref={veilRef} className="route-veil" aria-hidden="true" />
      <div
        key={pathname}
        ref={wrapperRef}
        className="page-transition"
        data-animate-route={animateRoute}
        data-route-section={section}
      >
        {children}
      </div>
    </>
  );
}

type RouteAnimation = "true" | "false";

function playVeil(veil: HTMLElement) {
  veil.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: VEIL_DURATION_MS,
    easing: VEIL_EASING,
  });
}

function routeAnimation(section: string, fromHistory: boolean): RouteAnimation {
  // Back/forward restores scroll and should feel instant, so it is not animated.
  if (
    fromHistory ||
    !animatedSections.has(section) ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return "false";
  }
  return "true";
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

  // Same-path links (including #hash anchors) are not route changes.
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
