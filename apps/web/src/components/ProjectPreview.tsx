"use client";

import { useEffect, useRef, useState } from "react";
import type { WebsiteProject } from "@/lib/external-projects";
import { assetUrl } from "@/lib/asset-url";
import { AuthenticatedAssetImage } from "./AuthenticatedAssetImage";
import styles from "./Projects.module.css";

export function ProjectPreview({ project, active, auto, coverOverride }: {
  project: WebsiteProject; active: boolean; auto?: boolean; coverOverride?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [expired, setExpired] = useState(false);
  const src = project.preview_url || project.url;
  const cover = coverOverride || assetUrl(project.cover_image, "content-card");
  const allowed = active && project.preview_enabled && new URL(src).origin !== location.origin;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Read once now: ResizeObserver stays silent while a route wipe pauses rendering.
    setScale(element.clientWidth / 1280);
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / 1280));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setLoaded(false); setExpired(false);
    if (!allowed) return;
    const timer = setTimeout(() => setExpired(true), 12_000);
    return () => clearTimeout(timer);
  }, [allowed, src]);
  // With nothing else to show, the route wipe gives this frame a short head start.
  const pending = auto && !cover && project.preview_enabled && !loaded && !expired;
  return <div ref={ref} className={styles.preview} data-media-pending={pending ? "" : undefined}>
    {cover ? <AuthenticatedAssetImage src={cover} token={project.published ? undefined : ""} alt="" loading="lazy" />
      : <div className={styles.placeholder} data-waiting={auto && project.preview_enabled && !expired ? "" : undefined} aria-hidden="true"><span>◇</span></div>}
    {allowed && scale > 0 && (!expired || loaded) ? <div inert aria-hidden="true" className={styles.previewFrame}
      style={{ opacity: loaded ? 1 : 0 }}>
      <iframe src={src} title={`${project.title}动态预览`} tabIndex={-1}
        width={1280} height={800} style={{ transform: `scale(${scale})` }}
        sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"
        allow="autoplay 'none'; fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
        onLoad={() => setLoaded(true)} />
    </div> : null}
  </div>;
}
