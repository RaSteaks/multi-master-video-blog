"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { tabbable } from "tabbable";
import { AUTHOR_TRAY_INNER_RATIO, authorTrayBlades, authorTrayLayout, type AuthorTrayLayout, type AuthorTrayPoint } from "@/lib/author-tray-geometry";
import type { ActionMenuGroup } from "./ActionMenu";

const HOLD_DELAY_MS = 180;
// Matches .author-tray[data-closing] in globals.css.
const EXIT_MS = 150;
const EXPIRED_HINT = "登录已过期，点钢笔图标重新登录";
const EXPIRED_HINT_MS = 2400;

type TrayExit = "cancel" | "commit";

/** A held-key variant of the author actions; ordinary menu links remain the
 * keyboard/click alternative. This overlay never adds a scrim over media. */
export function AuthorTray({ enabled, expired, groups }: {
  enabled: boolean;
  /** An author device whose session lapsed: holding Tab explains why nothing
   * opens. A short Tab still moves focus, and visitors never reach this. */
  expired: boolean;
  groups: ActionMenuGroup[];
}) {
  const actions = useMemo(() => groups.flatMap(group => group.items).flatMap(item => "href" in item ? [item] : []), [groups]);
  const iris = useMemo(() => authorTrayBlades(actions.length), [actions.length]);
  const irisId = useId().replace(/:/g, "");
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<AuthorTrayLayout | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // The tray stays mounted through its exit, which is why it can animate at all.
  const [closing, setClosing] = useState<TrayExit | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !anchor) return;
    panel.focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    if (!enabled && !expired) { setAnchor(null); setHint(null); setClosing(null); return; }
    let pointer: AuthorTrayPoint | null = null;
    let held = false;
    let shown = false;
    let ready = false;
    let chosen: HTMLAnchorElement | null = null;
    let previousFocus: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;

    function unavailable() {
      return document.hidden || Boolean(document.fullscreenElement)
        || document.documentElement.dataset.watching === "fullscreen"
        || Boolean(document.querySelector("dialog[open], .action-menu[data-open='true'], .action-menu-panel.closing, .bg-control-panel.open, .bg-control-panel.closing"));
    }
    function editing(target: EventTarget | null) {
      return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], video, audio"));
    }
    function removeTray() {
      clearTimeout(exitTimer);
      exitTimer = undefined;
      setAnchor(null); setClosing(null); setSelected(null);
    }
    /** Without `exit` the tray vanishes at once: blur, resize, fullscreen and
     * modals must never leave a moving disk over what replaced them. */
    function dismiss(restoreFocus: boolean, exit: TrayExit | null = null, destination: HTMLAnchorElement | null = null) {
      const animate = shown && exit !== null && !matchMedia("(prefers-reduced-motion: reduce)").matches;
      const focusTarget = previousFocus;
      clearTimeout(timer);
      timer = undefined; held = false; shown = false; ready = false; chosen = null; previousFocus = null;
      setHint(null);
      function restoreFocusTo() {
        if (restoreFocus && focusTarget?.isConnected && !document.querySelector("dialog[open]")) focusTarget.focus({ preventScroll: true });
      }
      function finish() {
        // Navigate only once the tray is gone: the route wipe snapshots the old
        // page on the next frame and would otherwise freeze the disk into it.
        destination?.click();
        removeTray();
        restoreFocusTo();
      }
      if (!animate) { finish(); return; }
      setClosing(exit);
      if (!destination) restoreFocusTo();
      exitTimer = setTimeout(destination ? finish : removeTray, EXIT_MS);
    }
    function openAtPointer() {
      if (!enabled) { clearTimeout(hintTimer); setHint(EXPIRED_HINT); return; }
      if (!authorTrayLayout({ x: innerWidth / 2, y: innerHeight / 2 }, innerWidth, innerHeight)) {
        setHint("窗口空间不足，请放大窗口或使用页头工具"); return;
      }
      if (!pointer) { setHint("移动鼠标以展开圆盘"); return; }
      const layout = authorTrayLayout(pointer, innerWidth, innerHeight);
      if (!layout) {
        setHint("将鼠标移向页面中央，留出圆盘空间"); return;
      }
      shown = true; chosen = null;
      clearTimeout(exitTimer); exitTimer = undefined;
      setClosing(null); setSelected(null); setHint(null); setAnchor(layout);
    }
    function keydown(event: KeyboardEvent) {
      if (event.key !== "Tab") {
        if (held) {
          const consume = ready && !["Shift", "Alt", "Control", "Meta"].includes(event.key);
          dismiss(true, "cancel");
          if (consume) { event.preventDefault(); event.stopPropagation(); }
        }
        return;
      }
      if (event.repeat) {
        if (held) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || unavailable() || editing(event.target) || !matchMedia("(any-pointer: fine)").matches) return;
      // Native Tab can move focus to browser chrome before the hold threshold,
      // losing keyup. Defer page focus until release instead of racing that move.
      event.preventDefault();
      held = true;
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      timer = setTimeout(() => {
        if (!held || unavailable() || editing(document.activeElement)) { dismiss(false); return; }
        ready = true;
        openAtPointer();
      }, HOLD_DELAY_MS);
    }
    function keyup(event: KeyboardEvent) {
      if (event.key !== "Tab" || !held) return;
      if (!shown) {
        event.preventDefault();
        // Reuse tested focus ordering (including inert/disabled/radio rules),
        // rather than maintaining a second ad-hoc focus selector for the page.
        const targets = ready ? [] : tabbable(document.body);
        const index = previousFocus ? targets.indexOf(previousFocus) : -1;
        const next = targets[index + 1] || targets[0];
        const explained = ready && !enabled;
        dismiss(false);
        next?.focus();
        // Keep the reason readable after the key comes up.
        if (explained) {
          setHint(EXPIRED_HINT);
          hintTimer = setTimeout(() => setHint(null), EXPIRED_HINT_MS);
        }
        return;
      }
      event.preventDefault(); event.stopPropagation();
      // A scroll can move a target without moving the pointer. Commit only the
      // still-highlighted element actually under the cursor at release.
      const underPointer = pointer ? document.elementFromPoint(pointer.x, pointer.y)?.closest("[data-author-tray-index]") : null;
      const destination = !unavailable() && underPointer === chosen ? chosen : null;
      // Activate the real Link while mounted. Document navigation/unsaved-edit
      // guards must see the same click as the ordinary author menu.
      dismiss(true, destination ? "commit" : "cancel", destination);
    }
    function point(event: PointerEvent) {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!held || !ready) return;
      if (unavailable()) { dismiss(false); return; }
      // The first inward move establishes the center, never a selected action.
      if (!shown) { openAtPointer(); return; }
      const target = document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLAnchorElement>("[data-author-tray-index]");
      chosen = target && panelRef.current?.contains(target) ? target : null;
      setSelected(chosen ? Number(chosen.dataset.authorTrayIndex) : null);
    }
    function click(event: MouseEvent) {
      // Block real clicks before the site's capture-phase navigation handler.
      // Only the synthetic Link click dispatched by Tab release may commit.
      if (ready && event.isTrusted) { event.preventDefault(); event.stopPropagation(); }
    }
    function cancel() { dismiss(false); }
    // Zoom/resize and leaving the window invalidate cached client coordinates.
    // Wait for a fresh pointer event rather than opening at an old location.
    function forgetPointer() { pointer = null; cancel(); }
    function leave(event: PointerEvent) { if (!event.relatedTarget) forgetPointer(); }
    function visibility() { if (document.hidden) forgetPointer(); }
    function scroll() { if (ready) cancel(); }
    const observer = new MutationObserver(() => { if (held && unavailable()) cancel(); });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
    window.addEventListener("keydown", keydown, true); window.addEventListener("keyup", keyup, true);
    window.addEventListener("click", click, true);
    window.addEventListener("pointermove", point, { passive: true });
    window.addEventListener("pointerdown", point, { passive: true });
    window.addEventListener("pointerout", leave);
    window.addEventListener("pointercancel", forgetPointer); window.addEventListener("blur", forgetPointer);
    window.addEventListener("resize", forgetPointer); window.addEventListener("scroll", scroll, { passive: true });
    document.addEventListener("visibilitychange", visibility); document.addEventListener("fullscreenchange", cancel);
    return () => {
      clearTimeout(timer); clearTimeout(exitTimer); clearTimeout(hintTimer); observer.disconnect();
      window.removeEventListener("keydown", keydown, true); window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("pointerdown", point);
      window.removeEventListener("pointermove", point); window.removeEventListener("pointercancel", forgetPointer); window.removeEventListener("blur", forgetPointer);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("resize", forgetPointer); window.removeEventListener("scroll", scroll);
      document.removeEventListener("visibilitychange", visibility); document.removeEventListener("fullscreenchange", cancel);
      // Route or session changes cancel the gesture without focusing the old page.
      setAnchor(null); setHint(null); setSelected(null); setClosing(null);
    };
  }, [enabled, expired, actions]);

  if ((!enabled && !expired) || (!anchor && !hint)) return null;
  return createPortal(
    <div className="author-tray-layer" data-closing={closing ?? (anchor ? undefined : "hint")} onPointerDown={event => event.preventDefault()} onDragStart={event => event.preventDefault()}>
      {anchor ? <div ref={panelRef} className="author-tray" data-closing={closing ?? undefined} role="group" aria-label="快速创作托盘" aria-describedby="author-tray-hint" tabIndex={-1}
        style={{ left: anchor.x - anchor.radius, top: anchor.y - anchor.radius,
          "--author-tray-size": `${anchor.radius * 2}px`, "--author-tray-inner-size": `${AUTHOR_TRAY_INNER_RATIO * 100}%` } as CSSProperties}>
        <svg className="author-tray-iris" viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <radialGradient id={`${irisId}-metal`} gradientUnits="userSpaceOnUse" cx="50" cy="50" r="50">
              <stop offset="0.35" className="author-tray-metal-inner" />
              <stop offset="1" className="author-tray-metal-outer" />
            </radialGradient>
            {iris.blades.map((blade, index) => <clipPath key={index} id={`${irisId}-blade-${index}`}><path d={blade.fill} /></clipPath>)}
          </defs>
          <g className="author-tray-blades">
            {iris.blades.map((blade, index) => <g key={index}>
              <path d={blade.fill} fill={`url(#${irisId}-metal)`} />
              <g className="author-tray-blade-shade" clipPath={`url(#${irisId}-blade-${index})`}>
                <path d={blade.nextEdge} strokeWidth="4" /><path d={blade.nextEdge} strokeWidth="2.6" /><path d={blade.nextEdge} strokeWidth="1.2" />
              </g>
            </g>)}
            {iris.blades.map((blade, index) => <path key={index} className="author-tray-blade-edge" d={blade.edge} />)}
          </g>
          <path className="author-tray-hole" d={iris.hole} data-active={selected !== null} />
        </svg>
        {actions.map((item, index) => <Link key={item.href} href={item.href} prefetch={false} draggable={false}
          className="author-tray-action" style={{ clipPath: iris.blades[index].clipPath }} data-author-tray-index={index} data-selected={selected === index}
          aria-label={item.label} tabIndex={-1}
          onClick={event => { if (event.nativeEvent.isTrusted) event.preventDefault(); }}>
          <span className="author-tray-action-copy" style={{ left: `${iris.blades[index].labelX}%`, top: `${iris.blades[index].labelY}%`, "--author-tray-index": index } as CSSProperties}>
            {item.icon}<span>{item.label}</span>
          </span>
        </Link>)}
        <div className="author-tray-center">
          <kbd>Tab</kbd>
          <strong>{selected === null ? "移向功能" : actions[selected].label}</strong>
          <span>{selected === null ? "松开取消" : "松开执行"}</span>
        </div>
        <span id="author-tray-hint" className="author-tray-hint">按住 Tab 移动鼠标选择，松开 Tab 执行。回到圆心、移出圆盘或按 Esc 取消。</span>
      </div> : <div className="author-tray-edge-hint" role="status">{hint}</div>}
    </div>, document.body,
  );
}
