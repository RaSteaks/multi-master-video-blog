// Every list the author can arrange by hand. Arranged rows count up from 1, so a
// new work (sort_order 0) still arrives at the front of its list.
const SECTIONS = {
  videos: { collection: "video_projects", sort: "sort_order,-id" },
  posts: { collection: "posts", sort: "sort_order,-id" },
  albums: { collection: "albums", sort: "sort_order,-created_at,-id" },
  projects: { collection: "external_projects", sort: "sort_order,-id" },
};
const MAX_ORDERED_IDS = 1000;
const MAX_ROWS = 5000;

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function readIds(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_ORDERED_IDS
    || value.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(value).size !== value.length) {
    throw invalid(`排序必须是 2 至 ${MAX_ORDERED_IDS} 个不重复的作品编号。`);
  }
  return value;
}

/**
 * The whole collection after `ids` are rearranged. They take turns in the positions
 * they already hold, so drafts and works past the visible page stay where they are.
 */
function arrange(rows, ids) {
  const wanted = new Set(ids);
  const known = new Set(rows.map(row => row.id));
  if (ids.some(id => !known.has(id))) throw invalid("列表已发生变化，请刷新页面后重试。", 409);
  const next = ids[Symbol.iterator]();
  return rows.map(row => (wanted.has(row.id) ? next.next().value : row.id));
}

function createContentOrder({ request }) {
  async function save(section, input) {
    const { collection, sort } = SECTIONS[section];
    const ids = readIds(input);
    const params = new URLSearchParams({ fields: "id,sort_order", sort, limit: String(MAX_ROWS) });
    let rows;
    try {
      rows = (await request(`/items/${collection}?${params}`)).data;
    } catch (error) {
      // Directus drops an unknown field from a write and still answers 200, so
      // this read is the only place a missing migration can be told apart.
      if (error.statusCode === 403) throw invalid("内容排序字段尚未安装，请先运行 npm run setup:cms-schema。", 409);
      throw error;
    }
    const position = new Map(rows.map(row => [row.id, row.sort_order]));
    const updates = arrange(rows, ids).map((id, index) => ({ id, sort_order: index + 1 }))
      .filter(({ id, sort_order }) => position.get(id) !== sort_order);
    if (!updates.length) return { ids };
    const written = await request(`/items/${collection}?fields=id,sort_order`, { method: "PATCH", body: updates });
    const stored = new Map(written.data?.map(row => [row.id, row.sort_order]));
    if (updates.some(({ id, sort_order }) => stored.get(id) !== sort_order)) throw invalid("排序结果尚未确认，请刷新页面核对。", 502);
    return { ids };
  }
  return { save };
}

module.exports = { createContentOrder, arrange, readIds, SECTIONS };
