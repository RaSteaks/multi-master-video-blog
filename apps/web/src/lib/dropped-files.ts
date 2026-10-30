"use client";

import { useEffect } from "react";

export type DropKind = "video" | "photo" | "film" | "article";
let staged: { kind: DropKind; files: File[] } | undefined;
const listeners = new Set<() => void>();

/** Routing is only a convenience; the destination/API still validate file bytes. */
export function classifyDroppedFiles(files: Pick<File, "name" | "type">[], filmEnabled: boolean): DropKind {
  const kinds = files.map(file => {
    const name = file.name.toLowerCase();
    if (/\.(mp4|mov|m4v|mkv|webm)$/.test(name) || file.type.startsWith("video/")) return "video";
    if (/\.(avif|heif|heic|jpe?g|png|webp)$/.test(name)) return "photo";
    if (/\.tiff?$/.test(name) && filmEnabled) return "film";
    if (/\.md$/.test(name)) return "article";
    throw new Error(`不支持“${file.name}”。请选择视频、照片${filmEnabled ? "、TIFF" : ""}或 Markdown 文件。`);
  });
  if (!kinds.length) throw new Error("没有可导入的文件。");
  if (new Set(kinds).size !== 1) throw new Error("请分开拖入视频、照片、胶片扫描或 Markdown 文件。");
  if (kinds[0] === "article" && files.length !== 1) throw new Error("一次只能导入一篇 Markdown。");
  return kinds[0];
}

export function stageDroppedFiles(kind: DropKind, files: File[]) {
  // One pending handoff bounds references; no bytes or file names enter storage/URLs.
  staged = { kind, files };
  listeners.forEach(listener => listener());
}

export function useDroppedFiles(kind: DropKind, receive: (files: File[]) => void) {
  useEffect(() => {
    let active = true;
    const take = () => queueMicrotask(() => {
      // StrictMode's probe cleanup must not consume a handoff before its live mount.
      if (!active || staged?.kind !== kind) return;
      const files = staged.files;
      staged = undefined;
      receive(files);
    });
    listeners.add(take); take();
    return () => { active = false; listeners.delete(take); };
  }, [kind, receive]);
}
