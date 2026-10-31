const FIELDS = "id,title,description,url,preview_url,preview_enabled,open_mode,cover_image,published,sort_order,created_at,updated_at";
const PAGE_SIZE = 24;
const EXTERNAL_PROJECT_FIELDS = ["title", "description", "url", "preview_url", "preview_enabled", "open_mode", "published", "sort_order"];

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function websiteUrl(value, label, allowLocal) {
  if (typeof value !== "string" || value.length > 2048) throw invalid(`${label}必须是有效的网址（最多 2048 字符）。`);
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid(`${label}必须包含完整的 https:// 地址。`); }
  const local = allowLocal && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password) {
    throw invalid(`${label}须使用 HTTPS，且不能包含账号密码。`);
  }
  return url.href;
}

function booleanValue(value, label) {
  if (value === true || value === "true" || value === 1) return true;
  if (value === false || value === "false" || value === 0) return false;
  throw invalid(`${label}必须为布尔值。`);
}

/** Validate once at the write boundary. URLs are stored, never fetched by the API. */
function normalizeProject(input, { partial = false, allowLocal = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("网站信息必须为对象。");
  const result = partial ? {} : { description: "", preview_url: null, preview_enabled: true, open_mode: "iframe", published: false, sort_order: 0 };
  for (const field of Object.keys(input)) {
    if (!EXTERNAL_PROJECT_FIELDS.includes(field)) throw invalid(`不支持的网站字段：${field}`);
    const value = input[field];
    if (field === "title" || field === "description") {
      const limit = field === "title" ? 120 : 300;
      if (typeof value !== "string" || value.trim().length > limit || (field === "title" && !value.trim())) {
        throw invalid(field === "title" ? "请填写网站名称，最多 120 字符。" : "简介最多 300 字符。");
      }
      result[field] = value.trim();
    } else if (field === "url") result.url = websiteUrl(value, "网站地址", allowLocal);
    else if (field === "preview_url") result.preview_url = value === null || value === "" ? null : websiteUrl(value, "预览地址", allowLocal);
    else if (field === "published" || field === "preview_enabled") result[field] = booleanValue(value, field);
    else if (field === "open_mode") {
      if (!["iframe", "external"].includes(value)) throw invalid("请选择全屏查看或独立打开。");
      result.open_mode = value;
    } else {
      const order = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
      if (!Number.isSafeInteger(order) || Math.abs(order) > 1_000_000) throw invalid("排序必须是 -1000000 至 1000000 之间的整数。");
      result.sort_order = order;
    }
  }
  if (!partial && (!result.title || !result.url)) throw invalid("请填写网站名称和网站地址。");
  return result;
}

function createExternalProjects({ request, uploadCover, removeUploadedCover, allowLocal = false }) {
  async function list({ page = 1, managed = false } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw invalid("页码无效。");
    const params = new URLSearchParams({ fields: FIELDS, sort: "sort_order,-id", limit: String(PAGE_SIZE + 1), offset: String((page - 1) * PAGE_SIZE) });
    if (!managed) params.set("filter[published][_eq]", "true");
    const response = await request(`/items/external_projects?${params}`);
    return { projects: response.data.slice(0, PAGE_SIZE), hasMore: response.data.length > PAGE_SIZE };
  }

  async function save(id, input, { cover = null, removeCover = false } = {}) {
    const patch = normalizeProject(input, { partial: id !== null, allowLocal });
    const remove = booleanValue(removeCover, "移除封面");
    if (cover && remove) throw invalid("不能同时上传和移除封面。");
    if (!Object.keys(patch).length && !cover && !remove) throw invalid("没有需要保存的更改。");
    if (id !== null) {
      if (!Number.isSafeInteger(id) || id < 1) throw invalid("网站编号无效。");
      const existing = await request(`/items/external_projects/${id}?fields=id`);
      if (!existing.data) throw invalid("网站不存在。", 404);
    }
    const uploaded = cover ? await uploadCover(cover, patch.title || "网站封面") : null;
    const now = new Date().toISOString();
    const body = { ...patch, updated_at: now, ...(id === null ? { created_at: now } : {}),
      ...(uploaded || remove ? { cover_image: uploaded || null } : {}) };
    try {
      const response = await request(`/items/external_projects${id === null ? "" : `/${id}`}?fields=${FIELDS}`, {
        method: id === null ? "POST" : "PATCH", body,
      });
      if (!response.data?.id) throw Object.assign(invalid("保存结果尚未确认，请刷新项目列表核对后再操作。", 502), { directusAmbiguous: true });
      return response.data;
    } catch (error) {
      // An uncertain CMS write may already reference the new cover. Keep it;
      // only a confirmed rejection permits cleanup, never delete an old cover.
      if (uploaded && !error.directusAmbiguous) await removeUploadedCover(uploaded);
      throw error;
    }
  }
  return { list, save };
}

module.exports = { createExternalProjects, normalizeProject, EXTERNAL_PROJECT_FIELDS, FIELDS, PAGE_SIZE };
