"use client";

import { useId, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";

type TocItem = { id: string; text: string; level: number };

/**
 * Table of contents list. On phones a long list collapses behind a toggle ("目录 · N 节") so it
 * does not push the article down; picking a section closes it again and scrolls to the heading.
 * On wider screens the toggle is hidden by CSS and the list is always visible.
 */
export function ArticleToc({ label, items, collapsible }: { label: string; items: TocItem[]; collapsible: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();

  function select(event: MouseEvent<HTMLAnchorElement>, id: string) {
    if (!collapsible || !open) return;
    event.preventDefault();
    // Collapse first so the scroll target is measured against the final layout.
    flushSync(() => setOpen(false));
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
    history.replaceState(null, "", `#${id}`);
  }

  return (
    <>
      {collapsible ? (
        <button
          className="article-toc-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          <span>
            {label} · {items.length} 节
          </span>
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      ) : null}
      <p className="article-toc-label">{label}</p>
      <nav id={listId} data-collapsible={collapsible} data-open={open}>
        {items.map((item) => (
          <a
            className={`article-toc-level-${item.level}`}
            href={`#${item.id}`}
            key={item.id}
            onClick={(event) => select(event, item.id)}
          >
            {item.text}
          </a>
        ))}
      </nav>
    </>
  );
}
