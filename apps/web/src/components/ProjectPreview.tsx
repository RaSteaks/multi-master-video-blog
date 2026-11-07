"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { WebsiteFrameStatus, WebsitePreview } from "@/lib/external-projects";
import { assetUrl } from "@/lib/asset-url";
import { AuthenticatedAssetImage } from "./AuthenticatedAssetImage";
import styles from "./Projects.module.css";

export function ProjectPreview({ project, active, auto, coverOverride, fallback }: {
  project: WebsitePreview; active: boolean; auto?: boolean; coverOverride?: string; fallback?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [frameHeight, setFrameHeight] = useState(800);
  const [status, setStatus] = useState<WebsiteFrameStatus>("loading");
  const src = project.preview_url || project.url;
  const cover = coverOverride || assetUrl(project.cover_image, "content-card");
  const allowed = active && project.preview_enabled && new URL(src).origin !== location.origin;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Read once now: ResizeObserver stays silent while a route wipe pauses rendering.
    function resize(width: number, height: number) {
      if (!width) return;
      setScale(width / 1280);
      // Tall templates show more of the page, rather than stretching desktop pixels.
      setFrameHeight(Math.round(height * 1280 / width));
    }
    resize(element.clientWidth, element.clientHeight);
    const observer = new ResizeObserver(([entry]) => resize(entry.contentRect.width, entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setStatus("loading");
    if (!allowed) return;
    const timer = setTimeout(() => setStatus(current => current === "loading" ? "timeout" : current), 12_000);
    return () => clearTimeout(timer);
  }, [allowed, src]);
  // Only a frame actually scheduled to run may hold the route wipe or hide the fallback.
  const waiting = allowed && status === "loading";
  const pending = auto && !cover && waiting;
  return <div ref={ref} className={styles.preview} data-media-pending={pending ? "" : undefined}
    data-preview-state={allowed ? status : "idle"}>
    {cover ? <AuthenticatedAssetImage src={cover} token={project.published ? undefined : ""} alt="" loading="lazy" />
      : fallback ?? <div className={styles.placeholder} data-waiting={auto && waiting ? "" : undefined} aria-hidden="true"><span>◇</span></div>}
    {allowed && scale > 0 && (status === "loading" || status === "unverified") ? <div inert aria-hidden="true" className={styles.previewFrame}
      style={{ opacity: status === "unverified" ? 1 : 0 }}>
      <iframe key={src} src={src} title={`${project.title}动态预览`} tabIndex={-1}
        width={1280} height={frameHeight} style={{ transform: `scale(${scale})` }}
        sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"
        allow="autoplay 'none'; fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
        // Keep arbitrary sites compatible; load can also mean a CSP/network error page.
        onLoad={() => setStatus(current => current === "loading" ? "unverified" : current)}
        onError={() => setStatus("error")} />
    </div> : null}
  </div>;
}
