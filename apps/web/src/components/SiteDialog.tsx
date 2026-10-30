"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

// Nested dialogs can unmount together in either order. Only the first lock
// captures the page's overflow, and the last release restores it.
let activeDialogs = 0;
let originalBodyOverflow = "";

/** Shared native modal: browser focus containment, scroll ownership and an explicit exit. */
export function SiteDialog({ title, children, onRequestClose, className = "", actions, closeLabel = "关闭", wide = false }: {
  title: string; children: ReactNode; onRequestClose: () => void; className?: string;
  actions?: ReactNode; closeLabel?: string; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (activeDialogs === 0) originalBodyOverflow = document.body.style.overflow;
    activeDialogs++;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      activeDialogs--;
      if (activeDialogs === 0) document.body.style.overflow = originalBodyOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={`album-dialog${wide ? " album-dialog--wide" : ""} ${className}`}
    aria-labelledby={heading} onCancel={event => { event.preventDefault(); onRequestClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onRequestClose(); }}>
    <div className="album-dialog-surface">
      <header className="album-dialog-header">
        <h2 id={heading}>{title}</h2>
        <div className="site-dialog-actions">
          {actions}
          <button type="button" className="album-action-button" autoFocus onClick={onRequestClose}>{closeLabel}</button>
        </div>
      </header>
      {children}
    </div>
  </dialog>;
}
