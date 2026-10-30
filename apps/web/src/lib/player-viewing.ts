"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

const IDLE_MS = 2500;
type LockableOrientation = ScreenOrientation & { lock?: (orientation: "landscape") => Promise<void> };

/** Owns surrounding UI only. Never transforms, filters or copies media pixels. */
export function usePlayerViewing(videoRef: RefObject<HTMLVideoElement | null>, shellRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [immersive, setImmersive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [playing, setPlaying] = useState(false);
  const autoImmersive = useRef(false);
  const savedScroll = useRef<number | null>(null);
  const nativeFullscreen = useRef(false);
  const promotedFullscreen = useRef(false);
  const exitingFullscreen = useRef(false);
  const expanded = useRef(false);
  const immersiveRef = useRef(false);
  const orientationLocked = useRef(false);

  const toggleFullscreen = useCallback(async () => {
    const shell = shellRef.current;
    if (!shell) return;
    autoImmersive.current = false;
    if (document.fullscreenElement) { exitingFullscreen.current = true; await document.exitFullscreen(); return; }
    if (immersiveRef.current) { setImmersive(false); return; }
    savedScroll.current = scrollY;
    if (shell.requestFullscreen) {
      try {
        await shell.requestFullscreen();
        const video = videoRef.current;
        if (/Android/i.test(navigator.userAgent) && video && video.videoWidth > video.videoHeight) {
          try { await (screen.orientation as LockableOrientation).lock?.("landscape"); orientationLocked.current = true; }
          catch { /* Orientation locking is optional on Android browsers. */ }
        }
        return;
      } catch { /* Element fullscreen may be unavailable; retain the entire player in-page. */ }
    }
    setImmersive(true);
  }, [shellRef, videoRef]);

  useEffect(() => {
    immersiveRef.current = immersive;
    const shell = shellRef.current;
    if (!shell || !immersive) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Keep keyboard users in the immersive surface; Esc and the button both exit.
    shell.focus({ preventScroll: true });
    return () => { document.body.style.overflow = previousOverflow; };
  }, [immersive, shellRef]);

  useEffect(() => {
    const video = videoRef.current;
    const shell = shellRef.current;
    if (!enabled || !video || !shell) return;
    let timer: ReturnType<typeof setTimeout>;
    function synchronize() {
      clearTimeout(timer);
      const full = Boolean(document.fullscreenElement || nativeFullscreen.current || immersiveRef.current);
      const running = !video!.paused && !video!.ended;
      setFullscreen(full); setPlaying(running); setIdle(false);
      if (full && !expanded.current && savedScroll.current === null) savedScroll.current = scrollY;
      if (!full && expanded.current) {
        if (orientationLocked.current) { screen.orientation?.unlock(); orientationLocked.current = false; }
        if (savedScroll.current !== null) window.scrollTo({ top: savedScroll.current, behavior: "instant" });
        savedScroll.current = null;
      }
      expanded.current = full;
      if (full) document.documentElement.dataset.watching = "fullscreen";
      else if (running) document.documentElement.dataset.watching = "active";
      else delete document.documentElement.dataset.watching;
      if (!running) return;
      timer = setTimeout(() => {
        // Native video focus counts as control focus too; never fade a keyboard target.
        if (document.activeElement !== shell && shell!.contains(document.activeElement)) return;
        setIdle(true);
        if (!full) document.documentElement.dataset.watching = "idle";
      }, IDLE_MS);
    }
    function begin() { nativeFullscreen.current = true; synchronize(); }
    function end() { nativeFullscreen.current = false; synchronize(); }
    function orientation() {
      if (!matchMedia("(pointer: coarse) and (orientation: landscape)").matches) {
        if (autoImmersive.current) { autoImmersive.current = false; setImmersive(false); }
        return;
      }
      if (!video!.paused && !document.fullscreenElement && !immersiveRef.current) {
        savedScroll.current = scrollY; autoImmersive.current = true; setImmersive(true);
      }
    }
    function play() { synchronize(); orientation(); }
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey
        || document.querySelector('dialog[open], .author-menu[data-open="true"]')
        || (target instanceof HTMLElement && (target.isContentEditable || target.closest("input,textarea,select")))) return;
      if (event.key.toLowerCase() === "f") { event.preventDefault(); void toggleFullscreen(); }
      if (event.key === "Escape" && immersiveRef.current) { event.preventDefault(); autoImmersive.current = false; setImmersive(false); }
      if (event.key === "Tab" && immersiveRef.current) {
        const controls = Array.from(shell!.querySelectorAll<HTMLElement>("button, a[href], video[controls], [tabindex='0']")).filter(element => element.getClientRects().length);
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === shell)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    function fullscreenChanged() {
      synchronize();
      // Firefox's privileged native controls can consume double-clicks before
      // page handlers. Promote their video fullscreen while its user activation
      // is still available; refusal keeps the synchronized native fallback.
      if (!document.fullscreenElement) {
        promotedFullscreen.current = false;
        exitingFullscreen.current = false;
      } else if (exitingFullscreen.current || (promotedFullscreen.current && document.fullscreenElement === video)) {
        // Promotion stacks two fullscreen elements in Firefox. One exit must
        // unwind both, including Esc exposing the underlying video layer.
        exitingFullscreen.current = true;
        void document.exitFullscreen().catch(() => { exitingFullscreen.current = false; });
      } else if (document.fullscreenElement === video && shell?.requestFullscreen) {
        promotedFullscreen.current = true;
        void shell.requestFullscreen().catch(() => { promotedFullscreen.current = false; });
      }
    }
    const fullscreenRequest = () => { void toggleFullscreen(); };
    for (const event of ["pause", "ended", "emptied"]) video.addEventListener(event, synchronize);
    video.addEventListener("play", play);
    video.addEventListener("webkitbeginfullscreen", begin); video.addEventListener("webkitendfullscreen", end);
    for (const event of ["pointermove", "pointerdown", "keydown", "focusin", "focusout"]) document.addEventListener(event, synchronize);
    document.addEventListener("fullscreenchange", fullscreenChanged);
    document.addEventListener("keydown", keydown);
    window.addEventListener("player-fullscreen", fullscreenRequest); window.addEventListener("resize", orientation);
    synchronize();
    return () => {
      clearTimeout(timer);
      for (const event of ["pause", "ended", "emptied"]) video.removeEventListener(event, synchronize);
      video.removeEventListener("play", play);
      video.removeEventListener("webkitbeginfullscreen", begin); video.removeEventListener("webkitendfullscreen", end);
      for (const event of ["pointermove", "pointerdown", "keydown", "focusin", "focusout"]) document.removeEventListener(event, synchronize);
      document.removeEventListener("fullscreenchange", fullscreenChanged);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("player-fullscreen", fullscreenRequest); window.removeEventListener("resize", orientation);
    };
  }, [enabled, immersive, shellRef, toggleFullscreen, videoRef]);

  useEffect(() => () => {
    delete document.documentElement.dataset.watching;
    if (orientationLocked.current) screen.orientation?.unlock();
    if (savedScroll.current !== null) window.scrollTo({ top: savedScroll.current, behavior: "instant" });
  }, []);
  return { immersive, fullscreen, idle, playing, toggleFullscreen };
}
