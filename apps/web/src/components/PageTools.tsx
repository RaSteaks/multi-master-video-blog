"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionMenu, type ActionMenuItem } from "@/components/ActionMenu";
import { useCreateMenuBehavior } from "@/lib/create-menu-behavior";

/** Public tools have no knowledge of author identity, credentials or uploads. */
export function PageTools() {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);
  const [pastScreen, setPastScreen] = useState(false);
  const [notice, setNotice] = useState("");
  const behavior = useCreateMenuBehavior(open);
  const article = /^\/posts\/[^/]+$/.test(pathname);
  const video = /^\/videos\/[^/]+$/.test(pathname);
  const album = /^\/albums\/[^/]+$/.test(pathname);
  const list = ["/posts", "/videos", "/albums", "/project", "/about"].includes(pathname);
  const available = article || video || album || (list && pastScreen);
  useEffect(() => {
    const update = () => setPastScreen(scrollY > innerHeight);
    update(); setNotice("");
    window.addEventListener("scroll", update, { passive: true }); window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [pathname]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (!available || behavior.hidden || event.defaultPrevented || event.isComposing || event.repeat
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || document.querySelector("dialog[open]")
        || (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))) return;
      if (event.key.toLowerCase() === "n") { event.preventDefault(); setOpen(value => !value); }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [available, behavior.hidden]);
  useEffect(() => { if (!available) setOpen(false); }, [available]);
  if (!available) return null;

  function copy(timed = false) {
    const url = new URL(location.href);
    if (timed) url.searchParams.set("t", String(Math.floor(document.querySelector<HTMLVideoElement>(".player-shell video")?.currentTime || 0)));
    else url.searchParams.delete("t");
    if (!navigator.clipboard?.writeText) { setNotice("复制失败，请从地址栏复制链接。"); return; }
    void navigator.clipboard.writeText(url.href).then(() => setNotice("已复制"))
      .catch(() => setNotice("复制失败，请从地址栏复制链接。"));
  }
  const items: ActionMenuItem[] = [];
  if (pastScreen && !video) items.push({ label: "回到顶部", icon: <ToolIcon path="m6 10 6-6 6 6M12 4v16" />,
    onSelect: () => window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }) });
  if (article) items.push({ label: "本页目录", icon: <ToolIcon path="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
    onSelect: () => {
      const toc = document.querySelector<HTMLElement>(".article-toc nav, .article-toc");
      if (!toc) { setNotice("本文暂无目录。"); return; }
      const toggle = toc.closest(".article-toc")?.querySelector<HTMLButtonElement>('.article-toc-toggle[aria-expanded="false"]');
      toggle?.click();
      // Wait for ArticleToc's mobile disclosure to commit before focusing its nav.
      requestAnimationFrame(() => {
        toc.tabIndex = -1; toc.focus({ preventScroll: true }); toc.scrollIntoView({ block: "nearest", behavior: "instant" });
      });
    } });
  if (video && behavior.videoAvailable) items.push(
    { label: "全屏", icon: <ToolIcon path="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />, onSelect: () => window.dispatchEvent(new Event("player-fullscreen")) },
    { label: "复制当前时间点链接", icon: <ToolIcon path="M12 6v6l4 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18" />, keepOpen: true, onSelect: () => copy(true) },
  );
  if (article || video || album) items.push({ label: "复制本页链接", icon: <ToolIcon path="M8 8h12v12H8ZM16 8V4H4v12h4" />, keepOpen: true, onSelect: () => copy() });
  return <ActionMenu className={`create-menu${behavior.hidden ? " create-menu--hidden" : ""}${behavior.retreated ? " create-menu--retreated" : ""}`}
    open={open} onOpenChange={setOpen} hidden={behavior.hidden} label="页面工具" placement="up" groups={[{ items }]}
    trigger={<svg className="page-tools-swatches" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <rect x="3.6" y="3.6" width="8.5" height="8.5" rx="1.1" />
      <rect x="13.9" y="3.6" width="8.5" height="8.5" rx="1.1" />
      <rect x="13.9" y="13.9" width="8.5" height="8.5" rx="1.1" />
      <rect x="3.6" y="13.9" width="8.5" height="8.5" rx="1.1" />
    </svg>}
    footer={notice ? <p className="create-menu-notice" role="status">{notice}</p> : null} />;
}

function ToolIcon({ path }: { path: string }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
