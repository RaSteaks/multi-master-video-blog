"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ContactFrame } from "@/lib/contact-sheet";
import { WEBSITE_PREVIEW_LIMIT, WEBSITE_PREVIEW_MOBILE_QUERY } from "@/lib/external-projects";
import { ProjectPreview } from "./ProjectPreview";

/** Frames only passing through the viewport during a scroll should not load. */
const PREVIEW_SETTLE_MS = 250;
/** A pointer travelling along the strip should not fetch every frame it crosses. */
const INTENT_MS = 90;

function FrameContent({ frame, live }: { frame: ContactFrame; live: boolean }) {
  const title = <span className="contact-frame-title">{frame.title}</span>;
  return (
    <>
      <div className="contact-frame-picture" data-vt={frame.morphsCover ? "cover" : "frame"}>
        {frame.cover
          ? <img src={frame.cover} alt="" width={93} height={62} loading="lazy" decoding="async" />
          : frame.preview ? <ProjectPreview project={frame.preview} active={live} fallback={title} /> : title}
      </div>
      <span className="contact-frame-label">
        {frame.addedOn ? <time dateTime={frame.addedOn}>{frame.addedOn}</time> : null}
        <strong>{frame.title}</strong>
      </span>
    </>
  );
}

// A long strip must not fetch every destination from a low-memory host, but a frame
// someone is reaching for needs its page ready, or there is nothing for it to open into.
function FrameLink({ href, children }: { href: string; children: ReactNode }) {
  const [wanted, setWanted] = useState(false);
  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(dwell.current), []);
  return (
    <Link className="contact-frame" href={href} prefetch={wanted}
      onPointerEnter={() => { dwell.current = setTimeout(() => setWanted(true), INTENT_MS); }}
      onPointerLeave={() => clearTimeout(dwell.current)}
      onPointerDown={() => setWanted(true)} onFocus={() => setWanted(true)}>
      {children}
    </Link>
  );
}

function aimLamp(track: HTMLElement, target: EventTarget) {
  const frame = (target as Element).closest("li");
  if (!frame) return;
  track.style.setProperty("--lamp-x", `${frame.offsetLeft + frame.offsetWidth / 2}px`);
  if (track.dataset.lamp) return;
  // Flush, so an unlit lamp comes on under the frame rather than gliding to it.
  getComputedStyle(track).getPropertyValue("--lamp-x");
  track.dataset.lamp = "on";
}

function douseLamp(track: HTMLElement) {
  delete track.dataset.lamp;
}

export function ContactStrip({ frames }: { frames: ContactFrame[] }) {
  const trackRef = useRef<HTMLOListElement>(null);
  const [live, setLive] = useState<string[]>([]);

  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const mobile = matchMedia(WEBSITE_PREVIEW_MOBILE_QUERY);
    const visible = new Set<string>();
    let settle: ReturnType<typeof setTimeout>;
    function selectPreviews() {
      if (reduced.matches || document.hidden) return [];
      return frames.filter(frame => visible.has(frame.key))
        .slice(-(mobile.matches ? 1 : WEBSITE_PREVIEW_LIMIT)).map(frame => frame.key);
    }
    function update() {
      clearTimeout(settle);
      if (reduced.matches || document.hidden) { setLive([]); return; }
      settle = setTimeout(() => {
        setLive(selectPreviews());
      }, PREVIEW_SETTLE_MS);
    }
    function resize() {
      clearTimeout(settle);
      setLive(selectPreviews());
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.previewKey ?? "";
        if (entry.isIntersecting) visible.add(key); else visible.delete(key);
      }
      update();
    });
    trackRef.current?.querySelectorAll("[data-preview-key]").forEach(frame => observer.observe(frame));
    document.addEventListener("visibilitychange", update);
    reduced.addEventListener("change", update);
    mobile.addEventListener("change", resize);
    return () => {
      clearTimeout(settle);
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      reduced.removeEventListener("change", update);
      mobile.removeEventListener("change", resize);
    };
  }, [frames]);

  if (!frames.length) return null;
  return (
    <section className="contact-strip" aria-label="全部作品，从左到右由旧到新">
      <ol ref={trackRef} className="contact-strip-track"
        onPointerOver={event => { if (event.pointerType === "mouse") aimLamp(event.currentTarget, event.target); }}
        onPointerLeave={event => douseLamp(event.currentTarget)}
        onFocus={event => { if (event.target.matches(":focus-visible")) aimLamp(event.currentTarget, event.target); }}
        onBlur={event => douseLamp(event.currentTarget)}>
        {frames.map(frame => {
          const content = <FrameContent frame={frame} live={live.includes(frame.key)} />;
          return (
            <li key={frame.key} data-preview-key={frame.preview ? frame.key : undefined}>
              {frame.external ? (
                <a className="contact-frame" href={frame.href} target="_blank" rel="noopener noreferrer"
                  aria-label={`独立打开${frame.title}（新标签页）`}>
                  {content}
                </a>
              ) : (
                <FrameLink href={frame.href}>{content}</FrameLink>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
