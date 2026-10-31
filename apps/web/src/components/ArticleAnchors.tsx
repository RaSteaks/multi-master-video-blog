"use client";

import { useEffect } from "react";
import { cancelReadingScroll, isPlainPrimaryClick, scrollPageToElement } from "@/lib/reading-scroll";

/**
 * In-article #links — footnotes, their back-references and cross-references to headings —
 * use the same eased page jump as the TOC instead of the browser's fixed smooth scrolling.
 * Renders nothing; works on posts with or without a TOC.
 */
export function ArticleAnchors() {
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || !isPlainPrimaryClick(event)) return;
      const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href^="#"]');
      if (!link || !link.closest(".markdown-body")) return;
      const id = decodeURIComponent(link.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      event.preventDefault();
      // The history entry a native anchor click would add, so Back returns to the reference.
      if (location.hash !== link.hash) history.pushState(history.state, "", link.hash);
      // Focus moves only to targets that can hold it (e.g. a footnote's back-reference link).
      if (target.matches("a[href], button, input, select, textarea, [tabindex]")) {
        target.focus({ preventScroll: true });
      }
      scrollPageToElement(target);
    }
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      cancelReadingScroll();
    };
  }, []);
  return null;
}
