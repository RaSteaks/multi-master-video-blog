"use client";

import { useEffect, useState } from "react";

/** Keep decoration out of viewing surfaces, and yield during active reading. */
export function useCreateMenuBehavior(open: boolean) {
  const [hidden, setHidden] = useState(false);
  const [retreated, setRetreated] = useState(false);
  const [videoAvailable, setVideoAvailable] = useState(false);
  useEffect(() => {
    function mediaChanged() {
      setVideoAvailable(Boolean(document.querySelector(".player-shell video")));
      const playing = Array.from(document.querySelectorAll("video")).some(video => !video.paused && !video.ended);
      setHidden(Boolean(document.documentElement.dataset.watching === "fullscreen" || document.fullscreenElement || document.querySelector(".album-lightbox[open], .project-viewer[open]") || playing));
    }
    for (const event of ["play", "pause", "ended", "emptied", "fullscreenchange"]) document.addEventListener(event, mediaChanged, true);
    // Dialogs and players mount after client navigation; observe only structural
    // changes/open attributes, never animation styles or scroll positions.
    const observer = new MutationObserver(mediaChanged);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-watching"] });
    mediaChanged();
    return () => {
      observer.disconnect();
      for (const event of ["play", "pause", "ended", "emptied", "fullscreenchange"]) document.removeEventListener(event, mediaChanged, true);
    };
  }, []);
  useEffect(() => {
    let previous = scrollY;
    let near = false;
    let timer: ReturnType<typeof setTimeout>;
    function restore() { clearTimeout(timer); setRetreated(false); }
    function scroll() {
      const down = scrollY > previous;
      previous = scrollY;
      const focused = document.activeElement?.closest(".create-menu");
      setRetreated(down && !open && !near && !focused);
      clearTimeout(timer);
      timer = setTimeout(restore, 300);
    }
    function pointer(event: PointerEvent) {
      near = innerWidth - event.clientX < 120 && innerHeight - event.clientY < 120;
      if (near) restore();
    }
    function focus(event: FocusEvent) { if (event.target instanceof Element && event.target.closest(".create-menu")) restore(); }
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("pointermove", pointer, { passive: true });
    document.addEventListener("focusin", focus);
    if (open) restore();
    return () => { clearTimeout(timer); window.removeEventListener("scroll", scroll); window.removeEventListener("pointermove", pointer); document.removeEventListener("focusin", focus); };
  }, [open]);
  return { hidden, retreated, videoAvailable };
}
