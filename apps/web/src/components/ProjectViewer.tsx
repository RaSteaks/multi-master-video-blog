"use client";

import { useEffect, useState } from "react";
import { SiteDialog } from "./SiteDialog";
import type { WebsiteProject } from "@/lib/external-projects";
import styles from "./Projects.module.css";

export function ProjectViewer({ project, onClose }: { project: WebsiteProject; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const embeddable = new URL(project.url).origin !== location.origin;
  useEffect(() => {
    setLoaded(false); setSlow(false);
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [attempt]);
  return <SiteDialog title={project.title} onRequestClose={onClose} closeLabel="← 返回实验室"
    className={`project-viewer ${styles.viewer}`}
    actions={<a className="album-action-button" href={project.url} target="_blank" rel="noopener noreferrer">独立打开 ↗</a>}>
    <div className={styles.viewerBody}>
      {/* Same-origin pages must not receive both script and same-origin sandbox privileges. */}
      {embeddable ? <iframe key={attempt} src={project.url} title={`${project.title}完整网站`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        allow="fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
        referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} /> : null}
      {!loaded || !embeddable ? <div className={styles.viewerLoading} role="status">
        <p>{!embeddable ? "此页面请使用独立打开。" : slow ? "网页仍未响应，可以重试或独立打开。" : "正在打开网站…"}</p>
        {slow && embeddable ? <button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载</button> : null}
      </div> : null}
    </div>
    {/* A frame load event also fires for CSP/network failures. Never label it as success. */}
    <p className={styles.viewerHint}>内容未显示或功能受限？可使用右上角“独立打开”。</p>
  </SiteDialog>;
}
