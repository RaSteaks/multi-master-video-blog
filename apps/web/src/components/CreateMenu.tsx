"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionMenu, type ActionMenuGroup } from "@/components/ActionMenu";
import { AuthorSignIn } from "@/components/AuthorSignIn";
import { signOut, useAuthorSession } from "@/lib/author-session";
import { useCreateMenuBehavior } from "@/lib/create-menu-behavior";
import { classifyDroppedFiles, stageDroppedFiles } from "@/lib/dropped-files";
import { authorTaskLabel, useAuthorTasks } from "@/lib/author-tasks";

// The film-scan import is development-only, like its dialog in AlbumsToolbar.
const FILM_SCAN_ENABLED = process.env.NODE_ENV !== "production";

// The home page keeps its own upload cards; the writing and upload pages are
// the destinations themselves.
const HIDDEN_ON = new Set(["/", "/write", "/upload"]);

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

/** Reading tools for everyone; verified author sessions add publishing links. */
export function CreateMenu() {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const behavior = useCreateMenuBehavior(open);
  const session = useAuthorSession();
  const activity = useAuthorTasks(session.author);
  const [loginOpen, setLoginOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [exiting, setExiting] = useState(false);
  const [time, setTime] = useState(0);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    // Local upload controls own handled drag events; never route their selected files away.
    const allowed = (event: DragEvent) => !event.defaultPrevented && session.author && !HIDDEN_ON.has(pathname) && !behavior.hidden
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
    window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    window.addEventListener("dragend", leave);
    return () => {
      window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); window.removeEventListener("dragend", leave);
    };
  }, [session.author, pathname, behavior.hidden, router]);
  useEffect(() => {
    if (!session.author) return;
    setTime(Date.now());
    const timer = setInterval(() => setTime(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [session]);
  useEffect(() => { setCopied(false); setNotice(""); }, [pathname]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (HIDDEN_ON.has(pathname) || behavior.hidden || event.defaultPrevented || event.isComposing || event.repeat
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || document.querySelector("dialog[open]")
        || (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))) return;
      const key = event.key.toUpperCase();
      if (key === "N") { event.preventDefault(); setOpen(value => !value); return; }
      if (!open || !session.author) return;
      const item = GROUPS.flatMap(group => group.items).find(item => item.shortcut === key);
      if (item && "href" in item) { event.preventDefault(); setOpen(false); router.push(item.href); }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [pathname, open, session.author, behavior.hidden, router]);
  if (HIDDEN_ON.has(pathname)) return null;

  const reading: ActionMenuGroup = { items: [
    { label: "回到顶部", icon: <Icon><path d="m6 10 6-6 6 6M12 4v16" /></Icon>,
      onSelect: () => window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }) },
    { label: copied ? "已复制" : "复制本页链接", icon: <Icon><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></Icon>, keepOpen: true,
      onSelect: () => { void navigator.clipboard.writeText(location.href).then(() => { setCopied(true); setNotice(""); })
        .catch(() => setNotice("复制失败，请从地址栏复制链接。")); } },
    ...(/^\/posts\/[^/]+$/.test(pathname) ? [{ label: "本页目录", icon: <Icon><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></Icon>,
      onSelect: () => {
        const toc = document.querySelector<HTMLElement>(".article-toc nav, .article-toc");
        if (!toc) { setNotice("本文暂无目录。"); return; }
        toc.tabIndex = -1;
        toc.focus({ preventScroll: true });
        toc.scrollIntoView({ block: "nearest", behavior: "instant" });
      } }] : []),
  ] };

  const contextGroups = pathname === "/project" ? [GROUPS[2], GROUPS[0], GROUPS[1], reading]
    : pathname.startsWith("/albums") ? [GROUPS[1], GROUPS[0], GROUPS[2], reading]
    : pathname.startsWith("/videos") ? [{ ...GROUPS[0], items: [...GROUPS[0].items].reverse() }, GROUPS[1], GROUPS[2], reading]
    : pathname.startsWith("/posts") ? [...GROUPS, reading] : [reading, ...GROUPS];
  const albumContext: ActionMenuGroup[] = /^\/albums\/[^/]+$/.test(pathname)
    ? [{ items: [{ label: "上传到此相簿", href: `${pathname}?action=upload`, icon: <PhotoIcon /> }] }] : [];

  return (
    <>
    <ActionMenu
      className={`create-menu${behavior.hidden ? " create-menu--hidden" : ""}${behavior.retreated && !dragging ? " create-menu--retreated" : ""}${dragging ? " create-menu--dragging" : ""}`}
      open={open}
      onOpenChange={setOpen}
      hidden={behavior.hidden}
      label="页面工具"
      placement="up"
      groups={session.author ? [...albumContext, ...contextGroups] : [reading]}
      trigger={<><PlusIcon />{dragging ? <span className="create-menu-drop-label">松开以上传</span> : null}</>}
      decoration={<>
        <span className="create-menu-frame" aria-hidden="true">
          {[0, 1, 2, 3].map(corner => <svg key={corner} className={`create-menu-corner corner-${corner}`} viewBox="0 0 12 12"><path d="M1 11V1h10" /></svg>)}
        </span>
        {activity.tasks.length || activity.completed ? <svg className={`create-menu-progress${activity.completed ? " is-complete" : ""}${activity.tasks[0]?.progress === null ? " is-indeterminate" : ""}`}
          viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="28" pathLength="100"
            strokeDasharray={`${activity.completed ? 100 : activity.tasks[0]?.progress ?? 24} 100`} /></svg> : null}
      </>}
      header={activity.tasks.length ? <div className="create-menu-tasks" aria-label="进行中的任务">
        <p>进行中的任务</p>
        {activity.tasks.map(task => <div key={task.id}>
          <span>{task.label}</span><small>{authorTaskLabel(task)}{task.progress !== null ? ` · ${task.progress}%` : ""}</small>
        </div>)}
      </div> : null}
      footer={<>
        <p className="create-menu-notice" role="status">{notice || activity.error || (activity.completed ? "任务已完成" : "")}</p>
        {session.author ? <div className="author-session-status">
          <span>已登录 · 剩余 {Math.max(1, Math.ceil((session.expiresAt - (time || Date.now())) / 3600_000))} 小时</span>
          <button type="button" disabled={exiting} onClick={async () => {
            setExiting(true); setNotice("");
            try { await signOut(); }
            catch (cause) { setNotice(cause instanceof Error ? cause.message : "退出失败，请重试。"); }
            finally { setExiting(false); }
          }}>{exiting ? "正在退出…" : "退出"}</button>
        </div> : <button type="button" onClick={() => { setOpen(false); setLoginOpen(true); }}>作者登录</button>}
      </>}
    />
    {loginOpen ? <AuthorSignIn onClose={() => setLoginOpen(false)} /> : null}
    </>
  );
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

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
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
