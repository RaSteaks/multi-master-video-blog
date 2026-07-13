"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { LiquidBackground } from "./LiquidBackground";

type BgMode = "image" | "liquid";

const MODE_KEY = "mm-bg-mode";
const BLUR_KEY = "mm-bg-blur";
const IMAGE_KEY = "mm-bg-image";
const MIN_BLUR = 0;
const MAX_BLUR = 40;

/** Sections that ship their own liquid background layer. */
const liquidSections = new Set(["home", "videos", "posts"]);

function clampBlur(value: number) {
  return Math.min(MAX_BLUR, Math.max(MIN_BLUR, Math.round(value)));
}

/**
 * Site-wide background settings.
 *
 * Modes:
 * - auto (no user choice): each section keeps its designed backdrop —
 *   home/videos/posts show their liquid layers, other pages show the
 *   CMS background image
 * - image: the chosen background image everywhere (all liquid layers hidden)
 * - liquid: liquid flow everywhere (section variants kept; gray layer
 *   portaled in on pages without one); image layers hidden
 *
 * The button lives in the navbar; on the home page (header hidden) it is
 * portaled to a floating button at the bottom-right corner.
 */
export function BackgroundControl({
  images,
  defaultBlur = 8,
}: {
  images: string[];
  defaultBlur?: number;
}) {
  const pathname = usePathname() || "/";
  const section = pathname.split("/").filter(Boolean)[0] || "home";
  const isHome = section === "home";

  const hasImage = images.length > 0;
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setModeState] = useState<BgMode | null>(null);
  const [blur, setBlurState] = useState(clampBlur(defaultBlur));
  const [hasUserBlur, setHasUserBlur] = useState(false);
  const [image, setImageState] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(true);
  const panelId = useId();

  const currentImage = image ?? images[0] ?? null;

  // What the current page actually shows when the user hasn't chosen
  const effectiveMode: BgMode =
    mode ?? (liquidSections.has(section) || !hasImage ? "liquid" : "image");

  // Restore saved preferences after hydration
  useEffect(() => {
    setMounted(true);

    const savedMode = window.localStorage.getItem(MODE_KEY);
    if (savedMode === "image" || savedMode === "liquid") {
      setModeState(savedMode);
    }

    const savedBlur = window.localStorage.getItem(BLUR_KEY);
    if (savedBlur != null && Number.isFinite(Number(savedBlur))) {
      setBlurState(clampBlur(Number(savedBlur)));
      setHasUserBlur(true);
    }

    const savedImage = window.localStorage.getItem(IMAGE_KEY);
    if (savedImage && images.includes(savedImage)) {
      setImageState(savedImage);
    }
    // images is server-derived and stable for the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply mode to <html> so CSS can switch the layers
  useEffect(() => {
    document.documentElement.dataset.bgMode = mode ?? "auto";
  }, [mode]);

  // Apply the user blur override on <html>; .site-bg::after reads
  // var(--user-bg-blur, var(--site-bg-blur, 8px))
  useEffect(() => {
    if (!hasUserBlur) return;
    document.documentElement.style.setProperty("--user-bg-blur", `${blur}px`);
  }, [blur, hasUserBlur]);

  // Close the popover on outside click / Escape
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        restoreFocusRef.current = false;
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        restoreFocusRef.current = true;
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const firstControl = panelRef.current?.querySelector<HTMLElement>(
      "button:not(:disabled), input:not(:disabled)"
    );
    firstControl?.focus();

    return () => {
      if (restoreFocusRef.current) {
        toggleRef.current?.focus();
      }
    };
  }, [open]);

  function selectMode(next: BgMode) {
    setModeState(next);
    window.localStorage.setItem(MODE_KEY, next);
  }

  function selectImage(url: string) {
    setImageState(url);
    window.localStorage.setItem(IMAGE_KEY, url);
    // Picking a thumbnail implies wanting the image backdrop
    if (mode !== "image") selectMode("image");
  }

  function updateBlur(value: number) {
    const next = clampBlur(value);
    setBlurState(next);
    setHasUserBlur(true);
    window.localStorage.setItem(BLUR_KEY, String(next));
  }

  function reset() {
    window.localStorage.removeItem(MODE_KEY);
    window.localStorage.removeItem(BLUR_KEY);
    window.localStorage.removeItem(IMAGE_KEY);
    document.documentElement.style.removeProperty("--user-bg-blur");
    setHasUserBlur(false);
    setBlurState(clampBlur(defaultBlur));
    setModeState(null);
    setImageState(null);
  }

  // A non-default image needs its own layer painted over the server one
  const customImage =
    effectiveMode === "image" && currentImage && currentImage !== images[0]
      ? currentImage
      : null;

  const control = (
    <div
      className={`bg-control${isHome ? " bg-control-floating" : ""}`}
      ref={rootRef}
    >
      <button
        ref={toggleRef}
        type="button"
        className={`bg-control-toggle${open ? " active" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        aria-label="背景设置"
        title="背景设置"
        onClick={() => {
          restoreFocusRef.current = true;
          setOpen((value) => !value);
        }}
      >
        <SlidersIcon />
      </button>

      <div
        ref={panelRef}
        id={panelId}
        className={`bg-control-panel${open ? " open" : ""}`}
        role="dialog"
        aria-label="背景设置"
        aria-hidden={!open}
      >
        <p className="bg-control-title">背景样式</p>

        <div className="bg-control-modes" role="radiogroup" aria-label="背景样式">
          <button
            type="button"
            role="radio"
            aria-checked={effectiveMode === "image"}
            className={effectiveMode === "image" ? "active" : ""}
            onClick={() => selectMode("image")}
          >
            背景图片
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={effectiveMode === "liquid"}
            className={effectiveMode === "liquid" ? "active" : ""}
            onClick={() => selectMode("liquid")}
          >
            液体流动
          </button>
        </div>

        {effectiveMode === "image" ? (
          <>
            {!hasImage ? (
              <p className="bg-control-note">
                尚未配置背景图：在 Directus 的 site_settings 中上传
                background_image / background_images
              </p>
            ) : null}

            {images.length > 1 ? (
              <div
                className="bg-control-thumbs"
                role="radiogroup"
                aria-label="选择背景图片"
              >
                {images.map((url, index) => (
                  <button
                    key={url}
                    type="button"
                    role="radio"
                    aria-checked={currentImage === url}
                    aria-label={`背景图片 ${index + 1}`}
                    className={currentImage === url ? "active" : ""}
                    style={{ backgroundImage: `url(${url})` }}
                    onClick={() => selectImage(url)}
                  />
                ))}
              </div>
            ) : null}

            {hasImage ? (
              <div className="bg-control-slider">
                <div className="bg-control-header">
                  <span>背景模糊</span>
                  <output>{blur}px</output>
                </div>
                <input
                  type="range"
                  min={MIN_BLUR}
                  max={MAX_BLUR}
                  step={1}
                  value={blur}
                  aria-label="背景模糊程度"
                  onChange={(event) => updateBlur(Number(event.target.value))}
                />
              </div>
            ) : null}
          </>
        ) : (
          <p className="bg-control-note">
            调色室风格流动背景 · 各栏目配色不同
          </p>
        )}

        <button type="button" className="bg-control-reset" onClick={reset}>
          恢复默认
        </button>
      </div>

      {mounted &&
      effectiveMode === "liquid" &&
      !liquidSections.has(section)
        ? createPortal(<LiquidBackground variant="gray" />, document.body)
        : null}

      {mounted && customImage
        ? createPortal(
            <div
              className="site-bg"
              style={
                {
                  backgroundImage: `url(${customImage})`,
                  "--site-bg-blur": `${defaultBlur}px`,
                } as React.CSSProperties
              }
              aria-hidden="true"
            />,
            document.body
          )
        : null}
    </div>
  );

  // Home hides the site header, so float the control at the bottom-right.
  if (isHome) {
    return mounted ? createPortal(control, document.body) : null;
  }

  return control;
}

function SlidersIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}
