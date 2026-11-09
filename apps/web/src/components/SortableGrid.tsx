"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type LiHTMLAttributes, type OlHTMLAttributes, type PointerEvent, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { useAuthorSession } from "@/lib/author-session";
import { applyOrder, moveId, nearestSlot, saveContentOrder, type ContentSection } from "@/lib/content-order";

export type SortableItem = { id: number; title: string; content: ReactNode; props?: LiHTMLAttributes<HTMLLIElement> & Record<`data-${string}`, unknown> };

// Holding an arrow key should send one save, not one per step.
const KEYBOARD_SAVE_DELAY_MS = 500;
const EDGE_SCROLL_ZONE = 88;
const EDGE_SCROLL_SPEED = 14;
// The sticky header covers the top of the window.
const HEADER_HEIGHT = 76;

type Drag = { id: number; pointerX: number; pointerY: number; grabX: number; grabY: number; order: number[]; start: number[]; frame: number };

function motion(list: HTMLElement) {
  const style = getComputedStyle(list);
  const duration = parseFloat(style.getPropertyValue("--motion-panel-duration"));
  const easing = style.getPropertyValue("--motion-ease").trim() || "ease-out";
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches || !Number.isFinite(duration);
  return { duration: still ? 0 : duration, easing };
}

/** Shift `card` from `dx, dy` back into its slot. Additive, so a card already gliding turns smoothly. */
function glideIn(card: HTMLElement, dx: number, dy: number, list: HTMLElement) {
  const { duration, easing } = motion(list);
  if (!duration || (!dx && !dy)) return;
  for (const child of card.children) {
    child.animate({ transform: [`translate(${dx}px, ${dy}px)`, "translate(0, 0)"] }, { duration, easing, composite: "add" });
  }
}

/** The author's manual ordering for one list. Visitors get the same list without a handle. */
export function SortableGrid({ section, items, label, className, listRef, listProps, refreshes = true }: {
  section: ContentSection; items: SortableItem[]; label: string; className: string;
  listRef?: RefObject<HTMLOListElement | null>; listProps?: OlHTMLAttributes<HTMLOListElement> & Record<`data-${string}`, unknown>;
  refreshes?: boolean;
}) {
  const router = useRouter();
  const session = useAuthorSession();
  const ownRef = useRef<HTMLOListElement>(null);
  const list = listRef ?? ownRef;
  const [saved, setSaved] = useState<number[] | null>(null);
  // Mid-drag the order is only visual. Moving the DOM node would drop the pointer
  // capture on its handle and reload a laboratory card's live frame.
  const [preview, setPreview] = useState<number[] | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");
  const drag = useRef<Drag | null>(null);
  const confirmed = useRef<number[] | null>(null);
  const unsent = useRef<number[] | null>(null);
  const sending = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flushRef = useRef<() => void>(() => {});

  const byId = new Map(items.map(item => [item.id, item]));
  const order = applyOrder(items.map(item => item.id), saved);
  const titleOf = (id: number) => byId.get(id)?.title ?? "";
  const sortable = session.author && items.length > 1;

  async function flush() {
    clearTimeout(saveTimer.current);
    const ids = unsent.current;
    if (sending.current || !ids) return;
    sending.current = true;
    unsent.current = null;
    try {
      await saveContentOrder(section, ids);
      confirmed.current = ids;
      setError("");
      if (!unsent.current) {
        setAnnouncement("顺序已保存");
        // Prefetched copies of this page must not bring the old order back.
        if (refreshes) router.refresh();
      }
    } catch (cause) {
      unsent.current = null;
      setSaved(confirmed.current);
      setAnnouncement("");
      setError(`${cause instanceof Error ? cause.message : "保存失败。"}已恢复之前的顺序。`);
    } finally {
      sending.current = false;
      if (unsent.current) void flushRef.current();
    }
  }

  useEffect(() => { flushRef.current = flush; });
  // Leaving the page must not lose an arrangement waiting on its delay.
  useEffect(() => () => flushRef.current(), []);

  function queueSave(ids: number[], delay = 0) {
    unsent.current = ids;
    clearTimeout(saveTimer.current);
    if (delay) saveTimer.current = setTimeout(() => void flush(), delay);
    else void flush();
  }

  const cards = () => Array.from(list.current?.querySelectorAll<HTMLElement>(":scope > li") ?? []);
  const cardOf = (id: number) => list.current?.querySelector<HTMLElement>(`:scope > li[data-sort-id="${id}"]`) ?? null;
  const measure = () => new Map(cards().map(card => [Number(card.dataset.sortId), card.getBoundingClientRect()]));

  function glideFrom(before: Map<number, DOMRect>, skip?: number) {
    if (!list.current) return;
    for (const card of cards()) {
      const id = Number(card.dataset.sortId);
      const from = before.get(id);
      if (!from || id === skip) continue;
      const to = card.getBoundingClientRect();
      glideIn(card, from.left - to.left, from.top - to.top, list.current);
    }
  }

  function follow() {
    const current = drag.current;
    const card = current && cardOf(current.id);
    if (!current || !card) return;
    const slot = card.getBoundingClientRect();
    const left = current.pointerX - current.grabX;
    const top = current.pointerY - current.grabY;
    const target = nearestSlot(cards().map(item => {
      const { left: x, top: y, width, height } = item.getBoundingClientRect();
      return { id: Number(item.dataset.sortId), left: x, top: y, width, height };
    }), current.id, left + slot.width / 2, top + slot.height / 2);
    if (target !== null) {
      const before = measure();
      current.order = moveId(current.order, current.id, current.order.indexOf(target));
      flushSync(() => setPreview(current.order));
      glideFrom(before, current.id);
    }
    const settled = card.getBoundingClientRect();
    card.style.setProperty("--drag-x", `${left - settled.left}px`);
    card.style.setProperty("--drag-y", `${top - settled.top}px`);
  }

  function tick() {
    const current = drag.current;
    if (!current) return;
    const above = HEADER_HEIGHT + EDGE_SCROLL_ZONE - current.pointerY;
    const below = current.pointerY - (innerHeight - EDGE_SCROLL_ZONE);
    const reach = Math.max(above, below) / EDGE_SCROLL_ZONE;
    if (reach > 0) window.scrollBy({ top: Math.sign(below - above) * Math.ceil(Math.min(reach, 1) * EDGE_SCROLL_SPEED), behavior: "instant" });
    follow();
    current.frame = requestAnimationFrame(tick);
  }

  function begin(event: PointerEvent<HTMLButtonElement>, id: number) {
    if (event.button !== 0 || drag.current) return;
    const card = cardOf(id);
    if (!card) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const box = card.getBoundingClientRect();
    drag.current = { id, pointerX: event.clientX, pointerY: event.clientY, grabX: event.clientX - box.left, grabY: event.clientY - box.top,
      order, start: order, frame: requestAnimationFrame(tick) };
    setPreview(order);
    setDragging(id);
    setError("");
  }

  function finish(keep: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    cancelAnimationFrame(current.frame);
    const card = cardOf(current.id);
    const before = measure();
    const box = card?.getBoundingClientRect();
    const lifted = card && box ? {
      x: box.left + (parseFloat(card.style.getPropertyValue("--drag-x")) || 0),
      y: box.top + (parseFloat(card.style.getPropertyValue("--drag-y")) || 0),
    } : null;
    const next = keep ? current.order : current.start;
    const changed = next.some((id, index) => id !== current.start[index]);
    const handle = card?.querySelector("button.sort-handle");
    const hadFocus = handle === document.activeElement;
    flushSync(() => {
      setPreview(null);
      setDragging(null);
      if (changed) setSaved(next);
    });
    card?.style.removeProperty("--drag-x");
    card?.style.removeProperty("--drag-y");
    glideFrom(before, current.id);
    if (card && lifted && list.current) {
      const slot = card.getBoundingClientRect();
      glideIn(card, lifted.x - slot.left, lifted.y - slot.top, list.current);
    }
    // React may have moved this card's node, which drops focus.
    if (hadFocus && handle instanceof HTMLElement) handle.focus({ preventScroll: true });
    if (!changed) return;
    setAnnouncement(`“${titleOf(current.id)}”已移到第 ${next.indexOf(current.id) + 1} 位，共 ${next.length} 项`);
    queueSave(next);
  }

  useEffect(() => {
    if (dragging === null) return;
    const cancel = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") finish(false); };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  });

  function step(event: KeyboardEvent<HTMLButtonElement>, id: number) {
    const index = order.indexOf(id);
    const firstRow = cards().filter(card => card.offsetTop === cards()[0]?.offsetTop).length || 1;
    const targets: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - firstRow, ArrowDown: index + firstRow, Home: 0, End: order.length - 1 };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const clamped = Math.max(0, Math.min(target, order.length - 1));
    if (clamped === index || drag.current) return;
    const next = moveId(order, id, clamped);
    const handle = event.currentTarget;
    const before = measure();
    flushSync(() => setSaved(next));
    glideFrom(before);
    handle.focus({ preventScroll: true });
    handle.closest("li")?.scrollIntoView({ block: "nearest" });
    setError("");
    setAnnouncement(`“${titleOf(id)}”已移到第 ${clamped + 1} 位，共 ${next.length} 项`);
    queueSave(next, KEYBOARD_SAVE_DELAY_MS);
  }

  return <>
    {error ? <p className="sortable-error" role="alert">{error}</p> : null}
    {sortable ? <p className="visually-hidden" role="status">{announcement}</p> : null}
    <ol {...listProps} ref={list} className={className} aria-label={label} data-sorting={dragging !== null ? "" : undefined}>
      {order.map(id => {
        const item = byId.get(id);
        if (!item) return null;
        const { style, ...props } = item.props ?? {};
        const position = preview?.indexOf(id);
        return <li key={id} {...props} data-sort-id={id} data-dragging={dragging === id ? "" : undefined}
          style={position === undefined ? style : { ...style, order: position }}>
          {item.content}
          {sortable ? <button type="button" className="sort-handle" title="拖动调整顺序"
            aria-label={`调整“${item.title}”的顺序，使用方向键移动`}
            onClick={event => {
              if (event.detail === 0) setAnnouncement("使用方向键移动，按 Home 或 End 移到首尾。");
            }}
            onPointerDown={event => begin(event, id)}
            onPointerMove={event => {
              if (!drag.current) return;
              drag.current.pointerX = event.clientX;
              drag.current.pointerY = event.clientY;
            }}
            onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)}
            onContextMenu={event => event.preventDefault()} onKeyDown={event => step(event, id)}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
              <circle cx="5.5" cy="3" r="1.3" /><circle cx="10.5" cy="3" r="1.3" />
              <circle cx="5.5" cy="8" r="1.3" /><circle cx="10.5" cy="8" r="1.3" />
              <circle cx="5.5" cy="13" r="1.3" /><circle cx="10.5" cy="13" r="1.3" />
            </svg>
          </button> : null}
        </li>;
      })}
    </ol>
  </>;
}
