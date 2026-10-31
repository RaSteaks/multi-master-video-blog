"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { requestAuthorSignIn, useAuthorDevice, useAuthorSession } from "@/lib/author-session";
import { projectRequest, readProjectList, readSavedProject, type WebsiteProject } from "@/lib/external-projects";
import { ActionMenu } from "./ActionMenu";
import { ListHeader } from "./ListHeader";
import { MediaCard } from "./MediaCard";
import { ProjectEditor } from "./ProjectEditor";
import { ProjectPreview } from "./ProjectPreview";
import { ProjectViewer } from "./ProjectViewer";
import styles from "./Projects.module.css";

type ProjectList = { projects: WebsiteProject[]; hasMore: boolean; unavailable: boolean };

/** Cards only passing through the viewport during a scroll should not load their frames. */
const PREVIEW_SETTLE_MS = 250;

export function ProjectGallery({ initial, createRequested }: { initial: ProjectList; createRequested: boolean }) {
  const router = useRouter();
  const session = useAuthorSession();
  const device = useAuthorDevice();
  const [managed, setManaged] = useState(false);
  const management = managed && session.author;
  const [list, setList] = useState(initial);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [mutation, setMutation] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<WebsiteProject | "create" | null>(createRequested ? "create" : null);
  const [requested, setRequested] = useState(createRequested);
  if (requested !== createRequested) {
    setRequested(createRequested);
    if (createRequested) setEditor("create");
  }
  const [viewing, setViewing] = useState<WebsiteProject | null>(null);
  const [live, setLive] = useState<number[]>([]);
  const galleryRef = useRef<HTMLOListElement>(null);
  const listRequest = useRef<AbortController | null>(null);
  const loadingMore = useRef(false);
  const locked = useRef(false);
  const requestVersion = useRef(0);
  const blocked = Boolean(viewing || editor);
  // Private rows disappear synchronously when the author session expires.
  const projects = management ? list.projects : list.projects.filter(project => project.published);

  useEffect(() => {
    const version = ++requestVersion.current;
    listRequest.current?.abort();
    setPage(1); setError("");
    if (!management) { setList(initial); setBusy(false); return; }
    const controller = new AbortController();
    listRequest.current = controller; setBusy(true);
    projectRequest("/manage", { signal: controller.signal }).then(readProjectList).then(result => {
      if (!controller.signal.aborted && version === requestVersion.current) setList({ ...result, unavailable: false });
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "网站列表加载失败。"); })
      .finally(() => { if (version === requestVersion.current) setBusy(false); });
    return () => controller.abort();
  }, [management, initial]);
  useEffect(() => () => listRequest.current?.abort(), []);

  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const visible = new Set<number>();
    let settle: ReturnType<typeof setTimeout>;
    function update() {
      clearTimeout(settle);
      if (blocked || reduced.matches || document.hidden) { setLive([]); return; }
      settle = setTimeout(commit, PREVIEW_SETTLE_MS);
    }
    // A frame arriving under the route wipe would pop in behind the divider.
    function commit() {
      if (document.documentElement.dataset.vtDirection) { settle = setTimeout(commit, PREVIEW_SETTLE_MS); return; }
      setLive([...visible]);
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.previewId);
        if (entry.isIntersecting) visible.add(id); else visible.delete(id);
      }
      update();
    });
    galleryRef.current?.querySelectorAll("[data-preview-id]").forEach(card => observer.observe(card));
    document.addEventListener("visibilitychange", update); reduced.addEventListener("change", update);
    update();
    return () => {
      clearTimeout(settle); observer.disconnect();
      document.removeEventListener("visibilitychange", update); reduced.removeEventListener("change", update);
    };
  }, [blocked, list.projects]);

  async function more() {
    if (loadingMore.current) return;
    loadingMore.current = true; setBusy(true); setError("");
    const version = requestVersion.current;
    const controller = new AbortController(); listRequest.current = controller;
    try {
      const result = readProjectList(await projectRequest(`${management ? "/manage" : ""}?page=${page + 1}`, { signal: controller.signal }, management));
      if (version !== requestVersion.current) return;
      setList(current => ({ projects: [...current.projects, ...result.projects.filter(item => !current.projects.some(old => old.id === item.id))], hasMore: result.hasMore, unavailable: false }));
      setPage(value => value + 1);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "加载失败，请重试。"); }
    finally { loadingMore.current = false; if (version === requestVersion.current) setBusy(false); }
  }

  function closeEditor() {
    setEditor(null);
    const url = new URL(location.href);
    if (url.searchParams.has("dialog")) {
      url.searchParams.delete("dialog");
      router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
    } else router.refresh();
  }

  async function publication(project: WebsiteProject) {
    if (locked.current) return;
    locked.current = true; setMutation(project.id); setError("");
    try {
      const updated = readSavedProject(await projectRequest(`/${project.id}`, { method: "PATCH", body: JSON.stringify({ published: !project.published }) }));
      setList(current => ({ ...current, projects: current.projects.map(item => item.id === updated.id ? updated : item) }));
      setNotice(updated.published ? "网站已发布到实验室。" : "已取消发布，网站保留为草稿。");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { locked.current = false; setMutation(null); }
  }

  return <>
    <ListHeader eyebrow="我制作的一些网页与视觉实验" title="实验室">
      {device ? <button type="button" className={styles.manageButton} aria-pressed={management} onClick={() => session.author ? setManaged(value => !value) : requestAuthorSignIn(() => setManaged(true))}>{management ? "返回公开展示" : "管理网站"}</button> : null}
    </ListHeader>
    {management ? <p className={styles.note}>草稿仅作者可见。通过页头工具中的“添加网站”创建，编辑网站可调整排序。</p> : null}
    <p className={styles.notice} role="status">{notice}</p>
    {error || list.unavailable ? <div className={styles.failure} role="alert">
      <p>{error || "实验室暂时无法载入，请稍后重试。"}</p>
      {session.author && list.unavailable ? <p>请确认媒体 API 正常运行，并已安装网站项目的 CMS 数据模型。</p> : null}
      <button type="button" onClick={() => { setManaged(false); router.refresh(); }}>重新加载</button>
    </div> : null}
    {!projects.length && !list.unavailable && !busy && !error ? <div className={styles.empty}>
      <span aria-hidden="true">◇</span><h2>{management ? "还没有网站项目" : "作品整理中"}</h2>
      <p>{session.author ? "从页头工具添加第一个网站。" : "新的网页实验将在这里展出。"}</p>
    </div> : null}
    <ol ref={galleryRef} className="content-grid content-grid--wide" aria-label="网站作品">
      {projects.map(project => <li key={project.id} id={`project-${project.id}`}
        data-preview-id={project.preview_enabled ? project.id : undefined}>
        {project.open_mode === "external" ? <a className={`content-card ${styles.cardEntry}`} href={project.url} target="_blank" rel="noopener noreferrer"
          aria-label={`独立打开${project.title}（新标签页）`}>
          <MediaCard meta="独立打开 ↗" title={project.title} description={project.description}
            media={<ProjectPreview project={project} active={live.includes(project.id) && !blocked} auto />} />
        </a> : <button type="button" className={`content-card ${styles.cardEntry}`} aria-label={`查看${project.title}`}
          onClick={event => { event.currentTarget.focus(); setViewing(project); }}>
          <MediaCard meta="站内查看" title={project.title} description={project.description}
            media={<ProjectPreview project={project} active={live.includes(project.id) && !blocked} auto />} />
        </button>}
        {management ? <div className={styles.cardManagement}>
          <span>{project.published ? "已发布" : "草稿"}</span>
          {mutation === project.id ? <span role="status">正在保存…</span> : <ActionMenu label={`管理${project.title}`} trigger="管理" groups={[{ items: [
            { label: "编辑网站", icon: <span aria-hidden="true">✎</span>, onSelect: () => setEditor(project) },
            { label: project.published ? "取消发布" : "发布到实验室", icon: <span aria-hidden="true">◇</span>, onSelect: () => void publication(project) },
          ] }]} />}
        </div> : null}
      </li>)}
    </ol>
    {list.hasMore ? <button type="button" className={styles.more} onClick={() => void more()} disabled={busy} aria-busy={busy}>{busy ? "正在加载…" : "加载更多"}</button> : busy ? <p role="status" className={styles.note}>正在加载网站…</p> : null}
    {editor ? <ProjectEditor project={editor === "create" ? null : editor} onClose={closeEditor} onSaved={saved => {
      setNotice(saved.published ? "网站已发布到实验室。" : "草稿已保存，可在管理网站中继续编辑。");
      closeEditor();
    }} /> : null}
    {viewing ? <ProjectViewer project={viewing} onClose={() => setViewing(null)} /> : null}
  </>;
}
