"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ContactFrame } from "@/lib/contact-sheet";
import { useWebsitePreviews } from "@/lib/use-website-previews";
import { ProjectPreview } from "./ProjectPreview";

/** A pointer travelling along the strip should not fetch every frame it crosses. */
const INTENT_MS = 90;

function FrameContent({ frame, live }: { frame: ContactFrame; live: boolean }) {
  const title = <span className="contact-frame-title">{frame.title}</span>;
  return (
    <>
      <div className="contact-frame-picture" data-vt={frame.morphsCover ? "cover" : "frame"}>
        {frame.cover
          // Directus owns the fixed-density variants; preserve the server-selected preview path.
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={frame.cover} srcSet={`${frame.cover} 1x, ${frame.cover}-2x 2x, ${frame.cover}-3x 3x`}
              alt="" width={93} height={62} loading="lazy" decoding="async" />
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

// The lamp is the strip's one selection: the frame's rise and its label are read from
// how near the lamp is (--lamp-i, in frames), so a look moving along the strip hands
// over in the lamp's own glide instead of one frame dropping as the next one pops.
function aimLamp(track: HTMLElement, target: EventTarget) {
  const frame = (target as Element).closest("li");
  // Bare film past either end: nothing there to look at.
  if (!frame) { douseLamp(track); return; }
  // A lamp still dimming from the last look glides from where it is, rather than
  // leaving that frame to drop at once.
  if (!track.dataset.lamp && parseFloat(getComputedStyle(track).getPropertyValue("--lamp-glow")) > 0) {
    track.dataset.lamp = "on";
  }
  track.style.setProperty("--lamp-x", `${frame.offsetLeft + frame.offsetWidth / 2}px`);
  track.style.setProperty("--lamp-i", frame.style.getPropertyValue("--i"));
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
  const [live, observeBudget] = useWebsitePreviews<string>();

  useEffect(() => {
    const visible = new Set<string>();
    const budget = observeBudget(limit => frames.filter(frame => visible.has(frame.key))
      .slice(-limit).map(frame => frame.key));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.previewKey ?? "";
        if (entry.isIntersecting) visible.add(key); else visible.delete(key);
      }
      budget.update();
    });
    trackRef.current?.querySelectorAll("[data-preview-key]").forEach(frame => observer.observe(frame));
    return () => {
      observer.disconnect();
      budget.disconnect();
    };
  }, [frames, observeBudget]);

  if (!frames.length) return null;
  return (
    <section className="contact-strip" aria-label="全部作品，从左到右由旧到新">
      <ol ref={trackRef} className="contact-strip-track"
        onPointerOver={event => { if (event.pointerType === "mouse") aimLamp(event.currentTarget, event.target); }}
        onPointerLeave={event => douseLamp(event.currentTarget)}
        onFocus={event => { if (event.target.matches(":focus-visible")) aimLamp(event.currentTarget, event.target); }}
        onBlur={event => {
          // Tabbing to the next frame keeps the lamp on, so it glides there.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) douseLamp(event.currentTarget);
        }}>
        {frames.map((frame, index) => {
          const content = <FrameContent frame={frame} live={live.includes(frame.key)} />;
          return (
            <li key={frame.key} data-preview-key={frame.preview ? frame.key : undefined}
              style={{ "--i": index } as CSSProperties}>
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
