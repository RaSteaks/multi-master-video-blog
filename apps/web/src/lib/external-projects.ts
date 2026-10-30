import { authorHeaders, observeAuthorResponse } from "./author-session";

export type WebsiteProject = {
  id: number;
  title: string;
  description: string;
  url: string;
  preview_url: string | null;
  preview_enabled: boolean;
  open_mode: "iframe" | "external";
  cover_image: string | null;
  published: boolean;
  sort_order: number;
};

export function isWebsiteUrl(value: string) {
  try {
    const url = new URL(value);
    const local = process.env.NODE_ENV !== "production" && url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || local) && !url.username && !url.password;
  } catch { return false; }
}

/** CMS can also be edited directly. Validate its rows before putting URLs in a frame. */
export function readWebsiteProject(value: unknown): WebsiteProject {
  if (!value || typeof value !== "object") throw new Error("网站数据格式无效。");
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.id) || Number(item.id) < 1 || typeof item.title !== "string"
    || !item.title.trim() || typeof item.url !== "string" || !isWebsiteUrl(item.url)
    || (item.description != null && typeof item.description !== "string")
    || (item.preview_url != null && item.preview_url !== "" && (typeof item.preview_url !== "string" || !isWebsiteUrl(item.preview_url)))
    || ![true, false, 0, 1].includes(item.preview_enabled as boolean)
    || ![true, false, 0, 1].includes(item.published as boolean)
    || !["iframe", "external"].includes(String(item.open_mode))
    || (item.cover_image != null && (typeof item.cover_image !== "string" || !/^[a-zA-Z0-9-]+$/.test(item.cover_image)))
    || (item.sort_order != null && !Number.isSafeInteger(item.sort_order))) throw new Error("网站数据格式无效，请检查 CMS 配置。");
  return {
    id: Number(item.id), title: item.title, description: (item.description as string | null) || "",
    url: item.url, preview_url: (item.preview_url as string | null) || null,
    preview_enabled: Boolean(item.preview_enabled), published: Boolean(item.published),
    open_mode: item.open_mode as WebsiteProject["open_mode"], cover_image: (item.cover_image as string | null) || null,
    sort_order: Number(item.sort_order || 0),
  };
}

export function readProjectList(value: unknown) {
  if (!value || typeof value !== "object" || !("projects" in value) || !Array.isArray(value.projects)
    || !("hasMore" in value) || typeof value.hasMore !== "boolean") throw new Error("网站列表响应无效。");
  return { projects: value.projects.map(readWebsiteProject), hasMore: value.hasMore };
}

export async function projectRequest(path: string, options: RequestInit = {}, managed = true): Promise<unknown> {
  const response = await fetch(`/api/external-projects${path}`, {
    ...options, credentials: "same-origin", cache: "no-store",
    signal: options.signal || AbortSignal.timeout(30_000),
    headers: { ...(managed ? authorHeaders("") : {}),
      ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}) },
  });
  if (managed) observeAuthorResponse(response.status, "");
  const data: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已过期，请从页头工具重新登录。");
    if (response.status === 403) throw new Error("当前登录状态无权执行此操作，请重新登录。");
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "请求失败。";
    throw new Error(response.status >= 500 ? "网站服务暂不可用，请检查 API 和 CMS 后重试。" : message);
  }
  return data;
}

export function readSavedProject(value: unknown) {
  if (!value || typeof value !== "object" || !("project" in value)) throw new Error("保存结果尚未确认，请刷新项目列表核对。");
  return readWebsiteProject(value.project);
}
