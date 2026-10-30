"use client";

import { useEffect, useState } from "react";
import { invalidateAuthorSession } from "./author-session";

export type AuthorTask = { id: string; kind: "video" | "film"; label: string; state: string; progress: number | null };
const ACTIVE = new Set(["receiving", "queued", "processing", "uploaded", "analyzing", "rendering", "resource_blocked"]);
const COMPLETE = new Set(["completed", "review_required", "committed"]);
const LABELS: Record<string, string> = { receiving: "正在上传", queued: "等待处理", processing: "正在转码",
  uploaded: "等待分析", analyzing: "正在分帧", rendering: "正在生成照片", resource_blocked: "等待可用资源" };
export const authorTaskLabel = (task: AuthorTask) => LABELS[task.state] || task.state;

function readTasks(value: unknown): AuthorTask[] {
  if (!value || typeof value !== "object" || !("tasks" in value) || !Array.isArray(value.tasks)) throw new Error("进度响应无效。");
  return value.tasks.map((task: unknown) => {
    if (!task || typeof task !== "object" || !("id" in task) || typeof task.id !== "string"
      || !("kind" in task) || (task.kind !== "video" && task.kind !== "film")
      || !("label" in task) || typeof task.label !== "string" || !("state" in task) || typeof task.state !== "string"
      || !("progress" in task) || !(task.progress === null || (typeof task.progress === "number" && Number.isFinite(task.progress) && task.progress >= 0 && task.progress <= 100))) {
      throw new Error("进度响应无效。");
    }
    return { id: task.id, kind: task.kind, label: task.label, state: task.state, progress: task.progress };
  });
}

export function useAuthorTasks(author: boolean) {
  const [tasks, setTasks] = useState<AuthorTask[]>([]);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!author) { setTasks([]); setCompleted(false); setError(""); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let successTimer: ReturnType<typeof setTimeout>;
    let previous = new Set<string>();
    let busy = false;
    async function poll() {
      if (busy || controller.signal.aborted) return;
      clearTimeout(timer);
      if (document.hidden) { timer = setTimeout(poll, 15_000); return; }
      busy = true;
      try {
        const response = await fetch("/api/author/tasks", { cache: "no-store", credentials: "same-origin",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (response.status === 401) { invalidateAuthorSession(); return; }
        if (!response.ok) throw new Error("暂时无法读取任务进度。");
        const next = readTasks(await response.json());
        if (controller.signal.aborted) return;
        if (next.some(task => previous.has(task.id) && COMPLETE.has(task.state))) {
          setCompleted(true); clearTimeout(successTimer); successTimer = setTimeout(() => setCompleted(false), 2500);
        }
        const active = next.filter(task => ACTIVE.has(task.state));
        previous = new Set(active.map(task => task.id));
        setTasks(active); setError("");
      } catch { if (!controller.signal.aborted) setError("暂时无法读取任务进度，将自动重试。"); }
      finally { busy = false; if (!controller.signal.aborted) timer = setTimeout(poll, document.hidden ? 15_000 : 5000); }
    }
    const visible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", visible); void poll();
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(successTimer); document.removeEventListener("visibilitychange", visible); };
  }, [author]);
  return { tasks, completed, error };
}
