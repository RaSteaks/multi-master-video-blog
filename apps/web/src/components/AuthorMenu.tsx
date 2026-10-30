"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionMenu, type ActionMenuGroup } from "@/components/ActionMenu";
import { AuthorSignIn } from "@/components/AuthorSignIn";
import { signOut, useAuthorDevice, useAuthorSession } from "@/lib/author-session";
import { classifyDroppedFiles, stageDroppedFiles } from "@/lib/dropped-files";
import { authorTaskLabel, useAuthorTasks } from "@/lib/author-tasks";

// The film-scan import is development-only, like its dialog in AlbumsToolbar.
const FILM_SCAN_ENABLED = process.env.NODE_ENV !== "production";

const DROP_HIDDEN_ON = new Set(["/write", "/upload", "/studio"]);

const GROUPS: ActionMenuGroup[] = [
  {
    items: [
      { label: "写文章", href: "/write", icon: <PenIcon />, shortcut: "W" },
      { label: "上传视频", href: "/upload", icon: <VideoIcon />, shortcut: "V", description: "SDR / HDR10 / HLG / Dolby Vision" },
    ],
  },
  {
    label: "相簿",
    items: [
      { label: "上传照片", href: "/albums?dialog=upload", icon: <PhotoIcon />, shortcut: "P", description: "SDR 与 HDR AVIF 配对" },
      { label: "新建相簿", href: "/albums?dialog=create", icon: <AlbumIcon />, shortcut: "A" },
      ...(FILM_SCAN_ENABLED
        ? [{ label: "导入胶片扫描", href: "/albums?dialog=film", icon: <FilmIcon />, shortcut: "F", description: "自动分帧" }]
        : []),
    ],
  },
  {
    label: "实验室",
    items: [{ label: "添加网站", href: "/project?dialog=create", icon: <WebsiteIcon />, shortcut: "L", description: "独立网页与视觉实验" }],
  },
];

/** Mounted client-side only; the device hint never grants access to author APIs. */
export function AuthorMenu() {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const device = useAuthorDevice();
  const session = useAuthorSession();
  const activity = useAuthorTasks(session.author);
  const [open, setOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const continuation = useRef<(() => void) | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [exiting, setExiting] = useState(false);
  const [time, setTime] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => { setNotice(""); }, [pathname]);
  useEffect(() => {
    if (open) activity.acknowledgeFailures();
  }, [open, activity.failed, activity.acknowledgeFailures]);

  useEffect(() => {
    function login(event: Event) {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "function") return;
      continuation.current = event.detail;
      setLoginOpen(true);
    }
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || event.repeat
        || document.querySelector("dialog[open]")
        || (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))) return;
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.shiftKey && event.code === "KeyL") {
        event.preventDefault(); continuation.current = undefined; setLoginOpen(true); return;
      }
      if (!open || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const item = GROUPS.flatMap(group => group.items).find(item => item.shortcut === event.key.toUpperCase());
      if (item && "href" in item) {
        event.preventDefault(); setOpen(false);
        if (session.author) router.push(item.href);
        else { continuation.current = () => router.push(item.href); setLoginOpen(true); }
      }
    }
    window.addEventListener("author-sign-in", login);
    document.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("author-sign-in", login); document.removeEventListener("keydown", keydown); };
  }, [open, router, session.author]);

  useEffect(() => {
    if (!session.author) return;
    setTime(Date.now());
    const timer = setInterval(() => setTime(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    let depth = 0;
    // Existing upload zones consume drops first. Global drops select, never submit.
    const allowed = (event: DragEvent) => !event.defaultPrevented && session.author && !DROP_HIDDEN_ON.has(pathname)
      && !document.fullscreenElement && document.documentElement.dataset.watching !== "fullscreen"
      && !document.querySelector("dialog[open]") && event.dataTransfer?.types.includes("Files");
    function enter(event: DragEvent) { if (allowed(event)) { event.preventDefault(); depth++; setDragging(true); } }
    function over(event: DragEvent) { if (allowed(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; } }
    function leave() { if (--depth <= 0) { depth = 0; setDragging(false); } }
    function drop(event: DragEvent) {
      depth = 0; setDragging(false);
      if (!allowed(event) || !event.dataTransfer) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      try {
        const kind = classifyDroppedFiles(files, FILM_SCAN_ENABLED);
        stageDroppedFiles(kind, files);
        router.push({ video: "/upload", photo: "/albums?dialog=upload", film: "/albums?dialog=film", article: "/write" }[kind]);
      } catch (cause) { setNotice(cause instanceof Error ? cause.message : "文件无法导入。"); setOpen(true); }
    }
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave); window.addEventListener("drop", drop); window.addEventListener("dragend", leave);
    return () => {
      window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); window.removeEventListener("dragend", leave);
    };
  }, [session.author, pathname, router]);

  const contextGroups = pathname === "/project" ? [GROUPS[2], GROUPS[0], GROUPS[1]]
    : pathname.startsWith("/albums") ? [GROUPS[1], GROUPS[0], GROUPS[2]] : GROUPS;
  const groups = /^\/albums\/[^/]+$/.test(pathname)
    ? [{ items: [{ label: "上传到此相簿", href: `${pathname}?action=upload`, icon: <PhotoIcon /> }] }, ...contextGroups] : contextGroups;
  const authenticatedGroups = groups.map(group => ({ ...group, items: group.items.map(item => {
    if (!("href" in item) || session.author) return item;
    const { href, ...action } = item;
    return { ...action, onSelect: () => { continuation.current = () => router.push(href); setLoginOpen(true); } };
  }) }));

  async function exit(forget: boolean) {
    setExiting(true); setNotice("");
    try { await signOut(forget); if (forget) setOpen(false); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "退出失败，请重试。"); }
    finally { setExiting(false); }
  }

  const menu = device ? <ActionMenu className={`author-menu${pathname === "/" ? " author-menu-floating" : ""}`}
    triggerClassName="bg-control-toggle" open={open} onOpenChange={setOpen} label="工具"
    placement={pathname === "/" ? "up" : "down"} groups={authenticatedGroups}
    trigger={<><Icon><path d="m16 3 5 5-12 12H4v-5Z M13 6l5 5" /></Icon>{activity.tasks.length || activity.completed || activity.failed ? <span className="author-task-dot"
      data-state={activity.failed ? "failed" : activity.completed ? "completed" : "active"} aria-hidden="true" /> : null}</>}
    header={activity.tasks.length || activity.failedTasks.length ? <div className="author-tasks">
      {activity.tasks.length ? <><p>进行中的任务</p>
        {activity.tasks.map(task => <div key={task.id}><span>{task.label}</span><small>{authorTaskLabel(task)}{task.progress !== null ? ` · ${task.progress}%` : ""}</small></div>)}
      </> : null}
      {activity.failedTasks.length ? <><p>需要处理的任务</p>
        {activity.failedTasks.map(task => <div key={task.id}><span>{task.label}</span><small>{authorTaskLabel(task)}</small></div>)}
      </> : null}
    </div> : null}
    footer={<>
      <p className="create-menu-notice" role="status">{notice || activity.error || (activity.completed ? "任务已完成" : "")}</p>
      <div className="author-session-status">
        <span>{session.author ? `已登录 · 剩余 ${Math.max(1, Math.ceil((session.expiresAt - (time || Date.now())) / 3600_000))} 小时` : "登录已过期"}</span>
        {session.author ? <button type="button" disabled={exiting} onClick={() => void exit(false)}>退出</button>
          : <button type="button" onClick={() => { setOpen(false); continuation.current = undefined; setLoginOpen(true); }}>作者登录</button>}
        <button type="button" disabled={exiting} onClick={() => void exit(true)}>退出并忘记此设备</button>
      </div>
    </>} /> : null;
  return <>
    {pathname === "/" ? createPortal(menu, document.body) : menu}
    {loginOpen ? <AuthorSignIn onClose={() => setLoginOpen(false)} onSuccess={() => { setLoginOpen(false); const next = continuation.current; continuation.current = undefined; next?.(); }} /> : null}
    {dragging ? createPortal(<div className="author-drop-layer" role="status">松开以上传</div>, document.body) : null}
  </>;
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function PenIcon() {
  return (
    <Icon>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Icon>
  );
}

function VideoIcon() {
  return (
    <Icon>
      <rect x="2.5" y="5" width="14" height="14" rx="2" />
      <path d="m16.5 10 5-3v10l-5-3" />
    </Icon>
  );
}

function PhotoIcon() {
  return (
    <Icon>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </Icon>
  );
}

function AlbumIcon() {
  return (
    <Icon>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </Icon>
  );
}

function FilmIcon() {
  return (
    <Icon>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18M17 3v18M3 7.5h4M3 12h4M3 16.5h4M17 7.5h4M17 12h4M17 16.5h4" />
    </Icon>
  );
}

function WebsiteIcon() {
  return <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 8h18M7 5.5h.01M10 5.5h.01M8 13l-2 2 2 2M16 13l2 2-2 2" /></Icon>;
}
