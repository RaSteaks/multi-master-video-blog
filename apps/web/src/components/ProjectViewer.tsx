"use client";

import { useEffect, useState } from "react";
import { SiteDialog } from "./SiteDialog";
import type { WebsiteFrameStatus, WebsiteProject } from "@/lib/external-projects";
import styles from "./Projects.module.css";

export function ProjectViewer({ project, onClose }: { project: WebsiteProject; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<WebsiteFrameStatus>("loading");
  const embeddable = new URL(project.url).origin !== location.origin;
  useEffect(() => {
    setStatus("loading");
    if (!embeddable) return;
    const timer = setTimeout(() => setStatus(current => current === "loading" ? "timeout" : current), 10_000);
    return () => clearTimeout(timer);
  }, [attempt, project.url, embeddable]);
  const statusMessage = !embeddable ? "此页面请使用独立打开。" : {
    loading: "正在打开网站…", unverified: "",
    timeout: "网页仍未响应，可以重试或独立打开。",
    error: "网页未能打开，可以重试或独立打开。",
  }[status];
  return <SiteDialog title={project.title} onRequestClose={onClose} closeLabel="← 返回实验室"
    className={`project-viewer ${styles.viewer}`}
    actions={<a className="album-action-button" href={project.url} target="_blank" rel="noopener noreferrer">独立打开 ↗</a>}>
    <div className={styles.viewerBody} data-preview-state={embeddable ? status : "idle"}>
      {/* Same-origin pages must not receive both script and same-origin sandbox privileges. */}
      {embeddable ? <iframe key={`${project.url}:${attempt}`} src={project.url} title={`${project.title}完整网站`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        allow="fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
        referrerPolicy="no-referrer" onLoad={() => setStatus("unverified")} onError={() => setStatus("error")} /> : null}
      {status !== "unverified" || !embeddable ? <div className={styles.viewerLoading} role="status">
        <p>{statusMessage}</p>
      </div> : null}
    </div>
    {/* A frame load event also fires for CSP/network failures. Never label it as success. */}
    <div className={styles.viewerHint}>
      <p>画面未显示或功能受限？可重试或独立打开。</p>
      {embeddable ? <button className="album-action-button" type="button" onClick={() => setAttempt(value => value + 1)}>重新加载</button> : null}
    </div>
  </SiteDialog>;
}
