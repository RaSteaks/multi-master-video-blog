"use client";

import { useEffect, useRef, useState } from "react";
import type { Lang } from "./UploadPageClient";
import { authorHeaders, canAuthorize, observeAuthorResponse, useAuthorSession } from "@/lib/author-session";

export type UploadProject = {
  id: number;
  title: string;
  slug: string;
  description?: string | null;
  tags?: string[] | null;
  published?: boolean | number;
  masters?: { id: number; type: string; label: string }[];
};

const copy = {
  zh: { search: "搜索项目标题或 Slug", load: "查找项目", linked: "读取此项目", loading: "正在读取项目…",
    empty: "没有找到项目，请更换关键词。", error: "无法读取项目，请检查令牌后重试。", choose: "选择项目",
    more: "加载更多", clear: "清除搜索", required: "请先填写上传令牌。", versions: "已有母版" },
  en: { search: "Search project title or slug", load: "Find projects", linked: "Load this project", loading: "Loading projects…",
    empty: "No projects found. Try another search.", error: "Could not load projects. Check the token and retry.", choose: "Choose project",
    more: "Load more", clear: "Clear search", required: "Enter your upload token first.", versions: "Existing masters" }
};

export function VideoProjectPicker({ token, lang, initialProjectId, selected, onSelect }: {
  token: string; lang: Lang; initialProjectId?: string; selected: UploadProject | null;
  onSelect: (project: UploadProject | null) => void;
}) {
  const t = copy[lang];
  const author = useAuthorSession();
  const credentialKey = token.trim() || (author.author ? author.csrf : "");
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<UploadProject[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    // Never reuse privileged results after the token changes or a picker unmounts.
    request.current?.abort();
    setProjects([]); setPage(0); setHasMore(false); setLoading(false); setError("");
    onSelect(null);
    return () => request.current?.abort();
  }, [credentialKey, onSelect]);

  async function load(nextPage = 1, id?: string) {
    if (!canAuthorize(token)) { setError(t.required); return; }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError("");
    const params = new URLSearchParams(id ? { id } : { search, page: String(nextPage) });
    try {
      const response = await fetch(`/api/uploads/video-projects?${params}`, {
        headers: authorHeaders(token), signal: controller.signal, cache: "no-store"
      });
      observeAuthorResponse(response.status, token);
      if (!response.ok) throw new Error(t.error);
      const data = await response.json() as { projects: UploadProject[]; hasMore: boolean };
      if (controller.signal.aborted) return;
      setProjects(current => nextPage === 1 ? data.projects : [...current, ...data.projects]);
      setPage(nextPage); setHasMore(data.hasMore);
      if (id && data.projects[0]) onSelect(data.projects[0]);
    } catch {
      if (!controller.signal.aborted) setError(t.error);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <div className="upload-project-picker">
    {initialProjectId && !selected ? <button type="button" disabled={loading || !canAuthorize(token)}
      onClick={() => void load(1, initialProjectId)}>{t.linked}</button> : null}
    <label>{t.search}<input value={search} type="search" onChange={event => {
      request.current?.abort(); setLoading(false); setSearch(event.target.value); setPage(0); setHasMore(false);
    }} onKeyDown={event => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void load(); }
    }} /></label>
    <div className="upload-actions">
      <button type="button" disabled={loading || !canAuthorize(token)} onClick={() => void load()}>{t.load}</button>
      {search ? <button type="button" onClick={() => {
        request.current?.abort(); setLoading(false); setSearch(""); setProjects([]); setPage(0); setHasMore(false);
      }}>{t.clear}</button> : null}
    </div>
    {loading || error || (page > 0 && !projects.length) ? <p role="status">
      {loading ? t.loading : error || t.empty}
    </p> : null}
    {projects.length ? <label>{t.choose}<select value={selected?.id ?? ""}
      onChange={event => onSelect(projects.find(project => String(project.id) === event.target.value) || null)}>
      <option value="">{t.choose}</option>
      {projects.map(project => <option key={project.id} value={project.id}>{project.title} — {project.slug}</option>)}
    </select></label> : null}
    {hasMore ? <button type="button" disabled={loading} onClick={() => void load(page + 1)}>{t.more}</button> : null}
    {selected ? <p className="field-note">{selected.title} · {t.versions}：
      {selected.masters?.map(master => master.label || master.type).join(" / ") || "—"}</p> : null}
  </div>;
}
