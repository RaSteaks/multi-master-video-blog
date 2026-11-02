import { authorHeaders, observeAuthorResponse } from "./author-session";

export type ContentSection = "videos" | "posts" | "albums" | "projects";

/** `saved` takes turns in the slots its ids hold, so works loaded or added later keep their own place. */
export function applyOrder(ids: number[], saved: number[] | null) {
  if (!saved) return ids;
  const present = new Set(ids);
  const known = new Set(saved);
  const arranged = saved.filter(id => present.has(id))[Symbol.iterator]();
  return ids.map(id => (known.has(id) ? arranged.next().value as number : id));
}

/** `id` taken out of `order` and put back at `index`. */
export function moveId(order: number[], id: number, index: number) {
  const rest = order.filter(item => item !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

type Slot = { id: number; left: number; top: number; width: number; height: number };

// Nearly equal distances would swap back and forth between two rows of different heights.
const SWAP_MARGIN = 8;

/** The slot nearest the dragged card's centre, or null while its own slot is still the nearest. */
export function nearestSlot(slots: Slot[], own: number, x: number, y: number) {
  const distance = (slot: Slot) => Math.hypot(slot.left + slot.width / 2 - x, slot.top + slot.height / 2 - y);
  const current = slots.find(slot => slot.id === own);
  if (!current) return null;
  const nearest = slots.reduce((best, slot) => (distance(slot) < distance(best) ? slot : best));
  return distance(nearest) < distance(current) - SWAP_MARGIN ? nearest.id : null;
}

export async function saveContentOrder(section: ContentSection, ids: number[]) {
  const response = await fetch(`/api/content-order/${section}`, {
    method: "PATCH", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { ...authorHeaders(""), "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
  });
  observeAuthorResponse(response.status, "");
  if (response.ok) return;
  if (response.status === 401) throw new Error("登录已过期，请重新登录。");
  if (response.status === 403) throw new Error("当前登录状态无权执行此操作，请重新登录。");
  // The site and the API deploy separately; an API older than this site has no such route.
  if (response.status === 404) throw new Error("API 服务还不支持排序，请重启或更新 API 后重试。");
  const data: unknown = await response.json().catch(() => null);
  const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "";
  throw new Error(response.status < 500 && message ? message : "排序服务暂不可用，请稍后重试。");
}
