"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type ActionMenuItem = {
  label: string;
  icon: ReactNode;
  /** Feedback actions such as copy keep their result visible in the panel. */
  keepOpen?: boolean;
  description?: string;
  shortcut?: string;
} & ({ href: string } | { onSelect: () => void });

export type ActionMenuGroup = {
  /** Shown above the group; omit for the first, unnamed group. */
  label?: string;
  items: ActionMenuItem[];
};

/**
 * A button that discloses a short list of actions (globals.css "Action menu").
 * It opens and closes like the appearance panel (AppearanceControl): a circle
 * grows from the trigger's centre to reveal the panel and shrinks back into
 * it on close, the panel staying mounted until that collapse ends; opening
 * moves focus to the first item.
 *
 * Disclosure, not an ARIA menu: Tab moves through the items as ordinary links
 * and buttons, and the arrow keys move between them as a shortcut. Escape,
 * a press outside, choosing an item or a route change closes it; Escape and
 * choosing a button item return focus to the trigger.
 */
export function ActionMenu({
  label,
  trigger,
  groups,
  placement = "down",
  className,
  triggerClassName,
  footer,
  header,
  decoration,
  open: controlledOpen,
  onOpenChange,
  hidden = false,
}: {
  /** Accessible name of the trigger; also names the panel. */
  label: string;
  trigger: ReactNode;
  groups: ActionMenuGroup[];
  /** Which side of the trigger the panel opens on; it aligns to the end edge. */
  placement?: "up" | "down";
  className?: string;
  triggerClassName?: string;
  footer?: ReactNode;
  header?: ReactNode;
  decoration?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hidden?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  function setOpen(value: boolean) { setLocalOpen(value); onOpenChange?.(value); }
  // Stays true after `open` turns false until the collapse animation ends.
  const [panelMounted, setPanelMounted] = useState(false);
  if (open && !panelMounted) setPanelMounted(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const pathname = usePathname();

  // A route change (including choosing a link item) closes the panel.
  useEffect(() => { setLocalOpen(false); onOpenChange?.(false); }, [pathname, onOpenChange]);
  useEffect(() => { if (hidden) { setLocalOpen(false); onOpenChange?.(false); } }, [hidden, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>(".action-menu-item")?.focus();
  }, [open]);

  // Reveal circle: centred on the trigger, its radius reaching the panel's
  // farthest corner, so it ends exactly when it covers the panel.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!open || !panel || !trigger) return;
    function measure() {
      if (!panel || !trigger) return;
      const panelBox = panel.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      const x = triggerBox.left + triggerBox.width / 2 - panelBox.left;
      const y = triggerBox.top + triggerBox.height / 2 - panelBox.top;
      const radius = Math.hypot(Math.max(x, panelBox.width - x), Math.max(y, panelBox.height - y));
      panel.style.setProperty("--reveal-x", `${x}px`);
      panel.style.setProperty("--reveal-y", `${y}px`);
      panel.style.setProperty("--reveal-r", `${Math.ceil(radius)}px`);
      rootRef.current?.style.setProperty("--menu-width", `${panel.offsetWidth}px`);
      rootRef.current?.style.setProperty("--menu-height", `${panel.offsetHeight}px`);
    }
    measure();
    // Signing in changes panel height while it remains open.
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open]);

  function close({ restoreFocus }: { restoreFocus: boolean }) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(".action-menu-item") ?? [],
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      current === -1
        ? event.key === "ArrowDown" ? 0 : items.length - 1
        : (current + step + items.length) % items.length;
    items[next].focus();
  }

  return (
    <div
      ref={rootRef}
      className={`action-menu${className ? ` ${className}` : ""}`}
      data-placement={placement}
      data-open={open}
      inert={hidden || undefined}
      aria-hidden={hidden || undefined}
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        className={`action-menu-trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {trigger}
      </button>

      {decoration}

      {open || panelMounted ? (
        <div
          ref={panelRef}
          id={panelId}
          className={`action-menu-panel ${open ? "open" : "closing"}`}
          role="group"
          aria-label={label}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && !open) setPanelMounted(false);
          }}
        >
          {header}
          {groups.map((group, groupIndex) => (
            <div className="action-menu-group" key={group.label ?? groupIndex}>
              {group.label ? <p className="action-menu-group-label">{group.label}</p> : null}
              {group.items.map((item) =>
                "href" in item ? (
                  <Link
                    className="action-menu-item"
                    aria-label={item.label}
                    aria-description={item.description}
                    href={item.href}
                    key={item.label}
                    onClick={() => close({ restoreFocus: false })}
                  >
                    {item.icon}
                    <span className="action-menu-copy">{item.label}{item.description ? <small>{item.description}</small> : null}</span>
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                  </Link>
                ) : (
                  <button
                    className="action-menu-item"
                    aria-label={item.label}
                    aria-description={item.description}
                    type="button"
                    key={item.label}
                    onClick={() => {
                      if (!item.keepOpen) close({ restoreFocus: true });
                      item.onSelect();
                    }}
                  >
                    {item.icon}
                    <span className="action-menu-copy">{item.label}{item.description ? <small>{item.description}</small> : null}</span>
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                  </button>
                ),
              )}
            </div>
          ))}
          {footer ? <div className="action-menu-footer">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
