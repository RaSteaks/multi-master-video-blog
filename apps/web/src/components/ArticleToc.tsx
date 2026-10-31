"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import {
  HANDOFF_EASE,
  READING_EASE,
  centeredScrollTop,
  cubicBezier,
  currentArticleHeading,
  readingHandoff,
  retargetEase,
  tocMotionDuration,
} from "@/lib/article-reading";
import { SCROLL_KEYS, cancelReadingScroll, isPlainPrimaryClick, scrollPageToElement } from "@/lib/reading-scroll";
import styles from "./ArticleReading.module.css";

type TocItem = { id: string; text: string; level: number };

/** After the reader scrolls the list themselves, the list rejoins no sooner than this. */
const TOC_READER_GRACE_MS = 1200;

type TocFollower = {
  container: HTMLElement;
  from: number;
  to: number;
  duration: number;
  /** Eased progress for the current glide; retargets match the speed already reached. */
  ease: (progress: number) => number;
  start: number;
  frame: number;
  /** scrollTop after our last write: anything else moving the list stops the glide. */
  written: number;
  lastTop: number;
  lastTime: number;
  velocity: number;
  /** performance.now() until which the reader's own scrolling has priority. */
  readerUntil: number;
  /** Set by the reader's own list scrolling; the list rejoins on the next section change. */
  paused: boolean;
  pausedIndex: number;
  /** Entry the indicator currently rests on (or leaves from). */
  index: number;
  stopInput: () => void;
};

/** Scroll distance over which the indicator slides to the next entry (shorter sections use their length). */
function handoffZone() {
  return Math.max(120, Math.min(320, window.innerHeight * 0.3));
}

/**
 * Table of contents list. On phones a long list collapses behind a toggle ("目录 · N 节") so it
 * does not push the article down; picking a section closes it again and scrolls to the heading.
 * On wider screens the toggle is hidden by CSS and the list is always visible.
 */
export function ArticleToc({ label, items, collapsible }: { label: string; items: TocItem[]; collapsible: boolean }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const navRef = useRef<HTMLElement>(null);
  const followerRef = useRef<TocFollower | null>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((heading): heading is HTMLElement => heading !== null);
    const article = headings[0]?.closest("article");
    if (!headings.length || !article) return;

    let frame = 0;
    let disposed = false;
    let previousId: string | null = null;

    function reconcile() {
      frame = 0;
      // Read the live CSS offset so mobile, zoom and resized text use the same
      // reading line as native anchor navigation; never depend on visible headings only.
      const readingLine = Number.parseFloat(getComputedStyle(headings[0]).scrollMarginTop) || 0;
      const bounds = article!.getBoundingClientRect();
      const nextId = currentArticleHeading(
        headings.map((heading) => ({ id: heading.id, top: heading.getBoundingClientRect().top })),
        readingLine,
        bounds.top <= readingLine && bounds.bottom <= window.innerHeight + 1,
      );
      if (previousId !== nextId) {
        previousId = nextId;
        setActiveId(nextId);
      }
    }

    function schedule() {
      if (!disposed && !frame) frame = requestAnimationFrame(reconcile);
    }

    // IO handles entry/exit and layout shifts; the passive scroll reconciliation
    // also catches fast jumps across several sections and upward scrolling.
    const observer = new IntersectionObserver(schedule, { threshold: [0, 1] });
    headings.forEach((heading) => observer.observe(heading));
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(article);
    const main = article.closest("main");
    if (main) resizeObserver.observe(main);
    headings.forEach((heading) => resizeObserver.observe(heading));
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    window.addEventListener("pageshow", schedule);
    document.fonts.ready.then(schedule);
    schedule();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
      window.removeEventListener("pageshow", schedule);
    };
  }, [items]);

  /**
   * Scroll-linked indicator and list. Every scroll frame writes the indicator's position
   * directly (no React render, no timed animation): it rests on the current entry and, over
   * the last stretch of scrolling before the next heading reaches the reading line, slides
   * to the next entry in step with the scroll (HANDOFF_EASE maps that distance). The entry
   * text brightens and dims with the indicator's coverage, so the whole highlight slides
   * rather than switching. The TOC's own scroll area follows the same way, keeping the
   * indicator centred. The reader's own list scrolling pauses the list until the next
   * section change, when it glides back on READING_EASE and rejoins. Reduced motion: no
   * in-between positions; the highlight steps at each section change.
   *
   * Geometry is measured only when layout changes (resize, images, fonts, opening the phone
   * list); scroll frames do arithmetic and writes only, so they never force a reflow.
   */
  useEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) return;
    const entries = items
      .map((item) => ({
        heading: document.getElementById(item.id),
        link: nav.querySelector<HTMLElement>(`a[data-toc-id="${CSS.escape(item.id)}"]`),
      }))
      .filter((entry): entry is { heading: HTMLElement; link: HTMLElement } => Boolean(entry.heading && entry.link));
    const article = entries[0]?.heading.closest("article");
    if (!article) return;
    const handoffEase = cubicBezier(...HANDOFF_EASE);
    type Box = { x: number; y: number; w: number; h: number };
    type Layout = {
      readingLine: number;
      /** Document offsets, so scrolling never needs a fresh measurement. */
      headingTops: number[];
      articleBottom: number;
      links: Box[];
      visible: boolean;
      list: { container: HTMLElement; navTop: number; viewportHeight: number; scrollHeight: number } | null;
    };
    let layout: Layout | null = null;
    let frame = 0;
    let placed = false;
    let drawn = { x: NaN, y: NaN, w: NaN, h: NaN };
    let emphasised: HTMLElement[] = [];
    const observed = new Set<Element>();

    function measure(): Layout {
      const scroll = window.scrollY;
      const container = scrollContainer(nav!);
      if (container && !observed.has(container)) {
        observed.add(container);
        observer.observe(container);
      }
      let list: Layout["list"] = null;
      if (container) {
        const containerBox = container.getBoundingClientRect();
        list = {
          container,
          navTop: nav!.getBoundingClientRect().top - containerBox.top - container.clientTop + container.scrollTop,
          viewportHeight: container.clientHeight,
          scrollHeight: container.scrollHeight,
        };
      }
      return {
        readingLine: Number.parseFloat(getComputedStyle(entries[0].heading).scrollMarginTop) || 0,
        headingTops: entries.map(({ heading }) => heading.getBoundingClientRect().top + scroll),
        articleBottom: article!.getBoundingClientRect().bottom + scroll,
        links: entries.map(({ link }) => ({ x: link.offsetLeft, y: link.offsetTop, w: link.offsetWidth, h: link.offsetHeight })),
        visible: entries[0].link.offsetWidth > 0,
        list,
      };
    }

    function emphasise(from: HTMLElement, to: HTMLElement | null, t: number) {
      // Only the entries under the indicator carry --toc-on; everything else is plain.
      const next = to && t > 0 ? [from, to] : [from];
      for (const link of emphasised) if (!next.includes(link)) link.style.removeProperty("--toc-on");
      from.style.setProperty("--toc-on", String(1 - t));
      if (to && t > 0) to.style.setProperty("--toc-on", String(t));
      emphasised = next;
    }

    function sync() {
      frame = 0;
      layout ??= measure();
      // Reads first (scroll offsets only), then writes: no forced layout in a scroll frame.
      const scroll = window.scrollY;
      const listScroll = layout.list?.container.scrollTop ?? 0;
      if (!layout.visible) {
        indicator!.dataset.visible = "false";
        return;
      }
      // Same end rule as the highlighted text: once the article end is visible the last
      // heading counts as reached, so headings that cannot reach the line are clamped there.
      const endScroll = layout.articleBottom - window.innerHeight;
      const crossings = layout.headingTops.map((top) => Math.min(endScroll, top - layout!.readingLine));
      const handoff = readingHandoff(crossings, scroll, handoffZone());
      if (!handoff) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const from = layout.links[handoff.index];
      const to = handoff.next !== null ? layout.links[handoff.next] : null;
      const t = to && !reduced ? handoffEase(handoff.progress) : 0;
      const mix = (a: number, b: number | undefined) => a + ((b ?? a) - a) * t;
      const box = { x: mix(from.x, to?.x), y: mix(from.y, to?.y), w: mix(from.w, to?.w), h: mix(from.h, to?.h) };

      // The indicator sits on its own compositor layer and moves by transform; size is only
      // written when it actually changes (wrapped titles).
      // Negated comparisons so the first frame (NaN "drawn" values) always writes.
      if (!(box.x === drawn.x && box.y === drawn.y)) indicator!.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
      if (!(Math.abs(box.w - drawn.w) <= 0.01)) indicator!.style.width = `${box.w}px`;
      if (!(Math.abs(box.h - drawn.h) <= 0.01)) indicator!.style.height = `${box.h}px`;
      drawn = box;
      indicator!.dataset.visible = "true";
      emphasise(entries[handoff.index].link, handoff.next !== null ? entries[handoff.next].link : null, t);
      syncList(box, handoff.index, reduced, listScroll);
      placed = true;
    }

    function syncList(box: Box, index: number, reduced: boolean, listScroll: number) {
      const list = layout?.list;
      if (!list) return;
      let follower = followerRef.current;
      if (!follower || follower.container !== list.container) {
        if (follower) stopFollower(follower);
        follower = createFollower(list.container);
        followerRef.current = follower;
      }
      const target = centeredScrollTop({
        itemTop: list.navTop + box.y,
        itemHeight: box.h,
        viewportHeight: list.viewportHeight,
        scrollHeight: list.scrollHeight,
      });
      const sectionChanged = index !== follower.index;
      follower.index = index;
      if (follower.paused) {
        // The reader is browsing the list: rejoin only on a later section, after the grace.
        if (performance.now() < follower.readerUntil || index === follower.pausedIndex || !sectionChanged) return;
        follower.paused = false;
        if (!reduced) {
          glideList(follower, target);
          return;
        }
      }
      if (follower.frame) {
        // A rejoin or first-placement glide is running: let it land on the moving target.
        follower.to = target;
        return;
      }
      if (!placed && !reduced && Math.abs(listScroll - target) >= 1) {
        // First placement (e.g. landing on a #hash) glides into place rather than jumping.
        glideList(follower, target);
        return;
      }
      if (Math.abs(listScroll - target) >= 0.5) {
        // "instant" overrides any CSS scroll-behavior, which would smooth every frame again.
        list.container.scrollTo({ top: target, behavior: "instant" });
      }
      follower.written = target;
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(sync);
    }
    function invalidate() {
      layout = null;
      schedule();
    }

    const observer = new ResizeObserver(invalidate);
    observer.observe(nav);
    observer.observe(article);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", invalidate);
    document.fonts.ready.then(invalidate);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", invalidate);
      for (const link of emphasised) link.style.removeProperty("--toc-on");
    };
  }, [items, open]);

  useEffect(() => () => {
    if (followerRef.current) stopFollower(followerRef.current);
    followerRef.current = null;
    cancelReadingScroll();
  }, []);

  function select(event: MouseEvent<HTMLAnchorElement>, id: string) {
    // Modified and non-primary clicks keep the browser's own link behaviour (new tab, etc.).
    if (!isPlainPrimaryClick(event)) return;
    const heading = document.getElementById(id);
    if (!heading) return;
    event.preventDefault();
    const hash = `#${encodeURIComponent(id)}`;
    if (collapsible && open) {
      // Collapse first so the scroll target is measured against the final layout.
      flushSync(() => setOpen(false));
      // Next stores router data here; replacing it with null breaks history restoration.
      history.replaceState(history.state, "", hash);
    } else if (location.hash !== hash) {
      // Same history entry a native anchor click would add, so Back returns to the previous spot.
      history.pushState(history.state, "", hash);
    }
    // Focus follows the jump as with a native anchor; headings stay outside the Tab order.
    heading.focus({ preventScroll: true });
    scrollPageToElement(heading);
  }

  return (
    <>
      {collapsible ? (
        <button
          className="article-toc-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          <span>
            {label} · {items.length} 节
          </span>
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      ) : null}
      <p className="article-toc-label">{label}</p>
      <nav
        ref={navRef}
        id={listId}
        className={styles.toc}
        aria-label={label}
        data-collapsible={collapsible}
        data-open={open}
      >
        <span ref={indicatorRef} className={styles.indicator} data-visible="false" aria-hidden="true" />
        {items.map((item) => (
          <a
            className={`article-toc-level-${item.level}`}
            href={`#${item.id}`}
            key={item.id}
            data-toc-id={item.id}
            aria-current={activeId === item.id ? "location" : undefined}
            onClick={(event) => select(event, item.id)}
          >
            {item.text}
          </a>
        ))}
      </nav>
    </>
  );
}

/** Nearest ancestor that scrolls on its own; the document itself never qualifies. */
function scrollContainer(element: HTMLElement) {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}

function createFollower(container: HTMLElement): TocFollower {
  const top = container.scrollTop;
  const follower: TocFollower = {
    container,
    from: top,
    to: top,
    duration: 0,
    ease: cubicBezier(...READING_EASE),
    start: 0,
    frame: 0,
    written: top,
    lastTop: top,
    lastTime: 0,
    velocity: 0,
    readerUntil: 0,
    paused: false,
    pausedIndex: -1,
    index: -1,
    stopInput: () => {},
  };
  // The reader's own wheel, touch, scrollbar drag or keyboard scrolling always wins. Picking
  // an entry (pointer or Enter on a link) is not scrolling the list, so following continues.
  const yield_ = (event: Event) => {
    if (event.type === "pointerdown" && (event.target as Element | null)?.closest?.("a")) return;
    if (event.type === "keydown" && !SCROLL_KEYS.has((event as KeyboardEvent).key)) return;
    halt(follower);
    follower.readerUntil = performance.now() + TOC_READER_GRACE_MS;
    follower.paused = true;
    follower.pausedIndex = follower.index;
  };
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  inputs.forEach((type) => container.addEventListener(type, yield_, { passive: true }));
  follower.stopInput = () => inputs.forEach((type) => container.removeEventListener(type, yield_));
  return follower;
}

/** Start (or redirect) a glide from where the list is drawn now. */
function glideList(follower: TocFollower, target: number) {
  const { container } = follower;
  const moving = follower.frame !== 0 && Math.abs(container.scrollTop - follower.written) <= 2;
  const current = container.scrollTop;
  const distance = target - current;
  const duration = tocMotionDuration(distance);
  if (!duration) {
    halt(follower);
    return;
  }
  // Mid-glide, the new curve starts at the speed already reached instead of from rest, and
  // its clock starts at the last drawn frame, so a late effect never shortens the next step.
  const velocity = moving ? follower.velocity : 0;
  const lastFrame = moving ? follower.lastTime : 0;
  follower.from = current;
  follower.to = target;
  follower.duration = duration;
  follower.ease = cubicBezier(...retargetEase(velocity, distance, duration));
  follower.start = lastFrame;
  follower.lastTop = current;
  follower.lastTime = lastFrame;
  follower.written = current;
  if (!follower.frame) follower.frame = requestAnimationFrame((now) => tick(follower, now));
}

function tick(follower: TocFollower, now: number) {
  follower.frame = 0;
  const { container } = follower;
  // Something else scrolled the list (scrollbar drag, find-in-page): stop gliding.
  if (!container.isConnected || Math.abs(container.scrollTop - follower.written) > 2) return;
  // The first frame advances one nominal frame; time spent before it is not motion.
  if (!follower.start) follower.start = now - 1000 / 60;
  const progress = Math.min(1, (now - follower.start) / follower.duration);
  const top = follower.from + (follower.to - follower.from) * follower.ease(progress);
  if (follower.lastTime) follower.velocity = (top - follower.lastTop) / Math.max(1, now - follower.lastTime);
  follower.lastTop = top;
  follower.lastTime = now;
  // "instant" overrides any CSS scroll-behavior, which would otherwise smooth every frame again.
  container.scrollTo({ top, behavior: "instant" });
  follower.written = container.scrollTop;
  if (progress < 1) follower.frame = requestAnimationFrame((time) => tick(follower, time));
  else follower.velocity = 0;
}

function halt(follower: TocFollower) {
  if (follower.frame) cancelAnimationFrame(follower.frame);
  follower.frame = 0;
  follower.velocity = 0;
}

function stopFollower(follower: TocFollower) {
  halt(follower);
  follower.stopInput();
}
