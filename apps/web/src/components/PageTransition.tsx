"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { routeReadiness, type RouteReadiness } from "@/lib/route-transition";

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
 * Where document.startViewTransition exists, link clicks are intercepted in
 * the capture phase and routed through it instead (see onClickCapture). Each
 * navigation gets one enter animation, chosen when its wait ends (see
 * routeReadiness):
 *   - content and the decoded cover are on screen: the browser cross-fades the
 *     page and morphs elements marked `data-vt` (cover, title) between the
 *     clicked card and the destination
 *   - content is on screen but the cover is not decoded: plain cross-fade
 *   - still a skeleton or not committed: the transition is skipped and handed
 *     to the veil, which plays once the real content replaces the skeleton
 * The veil also remains the fallback for unsupported browsers.
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

// How long a view transition waits for the destination. Rendering is
// suppressed on the old page while the transition callback is pending, so the
// app never extends the wait past this budget: a slower load skips the
// transition and falls back to the progress bar, skeleton and veil. Snapshot
// capture and main-thread work add to the visible freeze on top of it.
const VT_DECISION_MS = 180;

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const pathnameRef = useRef(pathname);
  // Incremented by every navigation. Async work (transition callbacks and
  // their completion) only touches shared state while its id is current.
  const navIdRef = useRef(0);
  // Id of the navigation whose enter animation a view transition owns. The
  // veil is skipped meanwhile: the browser cross-fades the page itself.
  const viewTransitionNavRef = useRef<number | null>(null);
  // Set when a skipped view transition hands its enter animation to the veil
  // after the route already committed, so the veil effect runs again.
  const [veilHandoff, setVeilHandoff] = useState(0);
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
    if (animateRoute !== "true" || viewTransitionNavRef.current !== null) return;

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
  }, [pathname, animateRoute, veilHandoff]);

  useLayoutEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

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
      navIdRef.current += 1;
      viewTransitionNavRef.current = null;
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

      beginNavigation();
    }

    function beginNavigation() {
      // A new link navigation supersedes any earlier popstate that never
      // changed the pathname (e.g. back across a hash-only history entry).
      historyNavRef.current = false;
      const id = (navIdRef.current += 1);
      // Superseded view transitions no longer own the enter animation.
      viewTransitionNavRef.current = null;

      if (pendingRef.current) {
        // A slow navigation is already in flight (rapid successive clicks):
        // keep the loading hint and only re-arm recovery for the newest one.
        armRecovery();
        return id;
      }

      clearTimer(thresholdTimerRef);
      thresholdTimerRef.current = window.setTimeout(
        markSlowNavigation,
        SLOW_NAV_THRESHOLD_MS,
      );
      return id;
    }

    // Capture phase on <html>: runs before React's root listener (so before
    // next/link starts the navigation) but after the editor's document-level
    // unsaved-changes guard, which may stop the click first.
    function onClickCapture(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        shouldIgnoreClick(event) ||
        typeof document.startViewTransition !== "function"
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!isInternalPageNavigation(anchor)) return;

      const url = new URL(anchor.href);
      const section = url.pathname.split("/").filter(Boolean)[0] || "home";
      if (routeAnimation(section, false) !== "true") return;

      event.preventDefault();
      event.stopPropagation();
      const id = beginNavigation();
      viewTransitionNavRef.current = id;
      // A superseded transition's names would duplicate this one's and abort it.
      clearSharedElementNames();
      const sharedKinds = markSharedElements(anchor);

      const fromPathname = pathnameRef.current;
      const isCurrent = () => navIdRef.current === id;
      const transition = document.startViewTransition(async () => {
        router.push(`${url.pathname}${url.search}${url.hash}`);
        const readiness = await waitForRouteReady(
          fromPathname,
          pathnameRef,
          sharedKinds.has("cover"),
          isCurrent,
        );
        // Superseded: the newer navigation owns all shared state.
        if (!isCurrent()) return;
        if (readiness === "shared") {
          // Only the first match per kind: a destination that is itself a list
          // (e.g. nav → /videos) has many [data-vt] elements, and duplicate
          // names would abort the whole transition.
          markSharedElements(document.getElementById("main-content"), sharedKinds);
          return;
        }
        // "content": the old snapshot is already captured, so the clicked
        // card's cover and title simply fade out with the page.
        if (readiness === "content") return;

        // Still loading: skip, and let the veil play once content arrives.
        // Before commit, the veil effect picks this up when the pathname
        // changes; after commit it has already run, so run it again.
        transition.skipTransition();
        viewTransitionNavRef.current = null;
        if (pathnameRef.current !== fromPathname) setVeilHandoff(id);
      });
      const done = () => {
        if (viewTransitionNavRef.current === id) viewTransitionNavRef.current = null;
        if (isCurrent()) clearSharedElementNames();
      };
      transition.finished.then(done, done);
    }

    // Listen at the end of the bubbling phase. The editor's unsaved-change
    // guard stops cancelled navigations before they can reach this handler.
    document.documentElement.addEventListener("click", onClickCapture, true);
    window.addEventListener("click", onClick);
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pageshow", clearTransition);

    return () => {
      document.documentElement.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", clearTransition);
      clearTransition();
    };
  }, [router]);

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

const SHARED_SELECTOR = "[data-vt]";

// Give the clicked card's cover/title (and later the matching elements on the
// destination page) a shared view-transition-name so the browser morphs one
// into the other. Names must be unique per document, so they only exist on
// the single pair involved in the current navigation. Without `kinds` every
// kind found under `root` is marked; with it, only those kinds (first match).
function markSharedElements(root: Element | null, kinds?: Set<string>) {
  const marked = new Set<string>();
  root?.querySelectorAll<HTMLElement>(SHARED_SELECTOR).forEach((element) => {
    const kind = element.dataset.vt;
    if (!kind || marked.has(kind) || (kinds && !kinds.has(kind))) return;
    marked.add(kind);
    element.style.setProperty("view-transition-name", `vt-${kind}`);
  });
  return marked;
}

function clearSharedElementNames() {
  document.querySelectorAll<HTMLElement>(SHARED_SELECTOR).forEach((element) => {
    element.style.removeProperty("view-transition-name");
  });
}

// Waits up to VT_DECISION_MS for the new route's real content (and, when the
// navigation morphs a cover, its decoded image) and reports what the
// transition should do (see routeReadiness). A superseded navigation stops
// waiting at once.
function waitForRouteReady(
  fromPathname: string,
  pathnameRef: { current: string },
  morphsCover: boolean,
  isCurrent: () => boolean,
) {
  return new Promise<RouteReadiness>((resolve) => {
    const main = document.getElementById("main-content");
    const startedAt = performance.now();
    let coverReady: boolean | null = morphsCover ? false : null;
    let watchedCover: HTMLImageElement | null = null;
    // The cover can never become ready: stop waiting for it.
    let coverUnavailable = false;
    let timer: number | undefined;
    let observer: MutationObserver | undefined;
    let settled = false;

    function finish(readiness: RouteReadiness) {
      settled = true;
      observer?.disconnect();
      window.clearTimeout(timer);
      resolve(readiness);
    }

    // Only an <img> cover can be confirmed decoded; any other cover (the
    // video player frame), a missing one or a failed decode cross-fades the
    // page without waiting out the budget.
    function watchCover() {
      const cover = main?.querySelector('[data-vt="cover"]');
      if (!(cover instanceof HTMLImageElement)) {
        coverUnavailable = true;
        return;
      }
      if (cover === watchedCover) return;
      watchedCover = cover;
      if (cover.complete && cover.naturalWidth > 0) {
        coverReady = true;
        return;
      }
      cover.decode().then(
        () => {
          if (watchedCover !== cover) return;
          coverReady = true;
          check();
        },
        () => {
          if (watchedCover !== cover) return;
          coverUnavailable = true;
          check();
        },
      );
    }

    function check() {
      if (settled) return;
      if (!isCurrent()) return finish("skip");
      const committed = pathnameRef.current !== fromPathname;
      const loading = committed && Boolean(main?.querySelector(LOADING_SELECTOR));
      if (committed && !loading && coverReady === false) watchCover();
      const readiness = routeReadiness({
        committed,
        loading,
        coverReady,
        // Set only once content is ready, so it can only yield "content".
        expired: coverUnavailable || performance.now() - startedAt >= VT_DECISION_MS,
      });
      if (readiness) finish(readiness);
    }

    if (main) {
      observer = new MutationObserver(check);
      observer.observe(main, { childList: true, subtree: true });
    }
    // Also re-check on a timer so the budget fires without further mutations.
    const tick = () => {
      check();
      if (settled) return;
      const remaining = VT_DECISION_MS - (performance.now() - startedAt);
      timer = window.setTimeout(tick, Math.max(0, Math.min(50, remaining)));
    };
    tick();
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
