"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import {
  COLOR_CHECKER_PRESETS,
  DEFAULT_ACCENT_HEX,
  THEME_STORAGE_KEY,
  chooseOnAccent,
  createStoredTheme,
  hexToHsv,
  hsvToHex,
  normalizeHsv,
  parseStoredTheme,
  resolveThemeColor,
  rgbChannels,
  srgbHexToRec709Hex,
  storedThemeToResolved,
  type ColorCheckerPresetId,
  type HsvColor,
  type ResolvedThemeColor,
  type StoredThemeColor,
} from "@/lib/theme-color";
import { LiquidBackground } from "./LiquidBackground";

type BgMode = "image" | "liquid";
type ColorEditor = "presets" | "custom";
type AppearanceView = "color" | "background";

const MODE_KEY = "mm-bg-mode";
const BLUR_KEY = "mm-bg-blur";
const IMAGE_KEY = "mm-bg-image";
const MIN_BLUR = 0;
const MAX_BLUR = 40;
const COLLAPSED_COLOR_CHECKER_COUNT = 12;

/** Sections that ship their own liquid background layer. */
const liquidSections = new Set(["home", "videos", "posts", "upload"]);

function clampBlur(value: number) {
  return Math.min(MAX_BLUR, Math.max(MIN_BLUR, Math.round(value)));
}

function roundedHsv(color: string) {
  return normalizeHsv(hexToHsv(color));
}

function isColorCheckerPresetFolded(presetId: ColorCheckerPresetId) {
  return (
    COLOR_CHECKER_PRESETS.findIndex((preset) => preset.id === presetId) >=
    COLLAPSED_COLOR_CHECKER_COUNT
  );
}

function applyThemeVariables(theme: ResolvedThemeColor | null) {
  const root = document.documentElement;
  if (!theme) {
    root.style.removeProperty("--user-accent-base");
    root.style.removeProperty("--user-accent-readable");
    root.style.removeProperty("--user-on-accent");
    root.style.removeProperty("--user-accent-rgb");
    delete root.dataset.themeColor;
    return;
  }

  root.style.setProperty("--user-accent-base", theme.base);
  root.style.setProperty("--user-accent-readable", theme.readable);
  root.style.setProperty("--user-on-accent", theme.onAccent);
  root.style.setProperty("--user-accent-rgb", rgbChannels(theme.rgb));
  root.dataset.themeColor = "local";
}

export function AppearanceControl({
  images,
  defaultBlur = 8,
  siteAccentColor = DEFAULT_ACCENT_HEX,
}: {
  images: string[];
  defaultBlur?: number;
  siteAccentColor?: string;
}) {
  const pathname = usePathname() || "/";
  const section = pathname.split("/").filter(Boolean)[0] || "home";
  const isHome = section === "home";
  const hasImage = images.length > 0;
  const siteTheme = useMemo(
    () => resolveThemeColor(siteAccentColor),
    [siteAccentColor]
  );

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setModeState] = useState<BgMode | null>(null);
  const [blur, setBlurState] = useState(clampBlur(defaultBlur));
  const [hasUserBlur, setHasUserBlur] = useState(false);
  const [image, setImageState] = useState<string | null>(null);
  const [themeReady, setThemeReady] = useState(false);
  const [storedTheme, setStoredTheme] = useState<StoredThemeColor | null>(null);
  const [appearanceView, setAppearanceView] =
    useState<AppearanceView>("color");
  const [colorEditor, setColorEditor] = useState<ColorEditor>("presets");
  const [customHsv, setCustomHsv] = useState<HsvColor>(() =>
    roundedHsv(siteTheme.base)
  );
  const [colorCheckerExpanded, setColorCheckerExpanded] = useState(false);
  const [inspectedPresetId, setInspectedPresetId] =
    useState<ColorCheckerPresetId | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(true);
  const panelId = useId();
  const panelTitleId = useId();
  const colorSectionId = useId();
  const colorCheckerId = useId();
  const backgroundSectionId = useId();

  const currentImage = image ?? images[0] ?? null;
  const effectiveMode: BgMode =
    mode ?? (liquidSections.has(section) || !hasImage ? "liquid" : "image");
  const effectiveTheme = storedTheme
    ? storedThemeToResolved(storedTheme)
    : siteTheme;

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

    const rawTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const parsedTheme = parseStoredTheme(rawTheme);
    if (parsedTheme) {
      setStoredTheme(parsedTheme);
      setColorEditor(parsedTheme.kind === "custom" ? "custom" : "presets");
      if (parsedTheme.kind === "custom" && parsedTheme.hsv) {
        setCustomHsv(parsedTheme.hsv);
      } else if (
        parsedTheme.kind === "preset" &&
        parsedTheme.presetId &&
        isColorCheckerPresetFolded(parsedTheme.presetId)
      ) {
        setColorCheckerExpanded(true);
      }
      applyThemeVariables(storedThemeToResolved(parsedTheme));
    } else if (rawTheme) {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
      applyThemeVariables(null);
    }
    setThemeReady(true);
    // Server-derived values are stable for this mounted layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.dataset.bgMode = mode ?? "auto";
  }, [mode]);

  useEffect(() => {
    if (!hasUserBlur) return;
    document.documentElement.style.setProperty("--user-bg-blur", `${blur}px`);
  }, [blur, hasUserBlur]);

  useEffect(() => {
    if (!themeReady) return;

    if (!storedTheme) {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
      applyThemeVariables(null);
      return;
    }

    applyThemeVariables(storedThemeToResolved(storedTheme));
    const timeout = window.setTimeout(() => {
      window.localStorage.setItem(
        THEME_STORAGE_KEY,
        JSON.stringify(storedTheme)
      );
    }, 80);

    return () => window.clearTimeout(timeout);
  }, [storedTheme, themeReady]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== THEME_STORAGE_KEY) return;
      const nextTheme = parseStoredTheme(event.newValue);
      setStoredTheme(nextTheme);
      if (nextTheme?.kind === "custom" && nextTheme.hsv) {
        setColorEditor("custom");
        setCustomHsv(nextTheme.hsv);
      } else if (nextTheme?.kind === "preset") {
        setColorEditor("presets");
        if (
          nextTheme.presetId &&
          isColorCheckerPresetFolded(nextTheme.presetId)
        ) {
          setColorCheckerExpanded(true);
        }
      }
      applyThemeVariables(
        nextTheme ? storedThemeToResolved(nextTheme) : null
      );
    }

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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
    if (mode !== "image") selectMode("image");
  }

  function updateBlur(value: number) {
    const next = clampBlur(value);
    setBlurState(next);
    setHasUserBlur(true);
    window.localStorage.setItem(BLUR_KEY, String(next));
  }

  function resetBackground() {
    window.localStorage.removeItem(MODE_KEY);
    window.localStorage.removeItem(BLUR_KEY);
    window.localStorage.removeItem(IMAGE_KEY);
    document.documentElement.style.removeProperty("--user-bg-blur");
    setHasUserBlur(false);
    setBlurState(clampBlur(defaultBlur));
    setModeState(null);
    setImageState(null);
  }

  function selectPreset(presetId: ColorCheckerPresetId) {
    const next = createStoredTheme({ kind: "preset", presetId });
    setStoredTheme(next);
    setColorEditor("presets");
    setInspectedPresetId(presetId);
    applyThemeVariables(storedThemeToResolved(next));
  }

  function openCustomEditor() {
    setCustomHsv(roundedHsv(effectiveTheme.base));
    setColorEditor("custom");
  }

  function updateCustomColor(nextValue: HsvColor) {
    const nextHsv = normalizeHsv(nextValue);
    const next = createStoredTheme({ kind: "custom", hsv: nextHsv });
    setCustomHsv(nextHsv);
    setStoredTheme(next);
    applyThemeVariables(storedThemeToResolved(next));
  }

  function resetTheme() {
    setStoredTheme(null);
    setColorEditor("presets");
    setCustomHsv(roundedHsv(siteTheme.base));
    setColorCheckerExpanded(false);
    setInspectedPresetId(null);
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    applyThemeVariables(null);
  }

  function updateSaturationValue(event: ReactPointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const saturation =
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
    const value =
      (1 - (event.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
    updateCustomColor({
      h: customHsv.h,
      s: saturation,
      v: value,
    });
  }

  function onSaturationValueKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>
  ) {
    const step = event.shiftKey ? 10 : 1;
    let next = customHsv;

    if (event.key === "ArrowLeft") {
      next = { ...customHsv, s: customHsv.s - step };
    } else if (event.key === "ArrowRight") {
      next = { ...customHsv, s: customHsv.s + step };
    } else if (event.key === "ArrowUp") {
      next = { ...customHsv, v: customHsv.v + step };
    } else if (event.key === "ArrowDown") {
      next = { ...customHsv, v: customHsv.v - step };
    } else {
      return;
    }

    event.preventDefault();
    updateCustomColor(next);
  }

  const customHex = hsvToHex(customHsv);
  const rec709Hex = srgbHexToRec709Hex(customHex);
  const activePresetId =
    storedTheme?.kind === "preset" ? storedTheme.presetId : undefined;
  const inspectedPreset =
    COLOR_CHECKER_PRESETS.find(
      (preset) => preset.id === (inspectedPresetId ?? activePresetId)
    ) ?? COLOR_CHECKER_PRESETS[0];
  const visibleColorCheckerPresets = COLOR_CHECKER_PRESETS.slice(
    0,
    colorCheckerExpanded
      ? COLOR_CHECKER_PRESETS.length
      : COLLAPSED_COLOR_CHECKER_COUNT
  );
  const sourceLabel = storedTheme
    ? storedTheme.kind === "preset"
      ? "本地预设"
      : "本地 HSV"
    : "站点默认";

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
        aria-label="外观设置"
        title="外观设置"
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
        aria-labelledby={panelTitleId}
        aria-hidden={!open}
      >
        <header className="appearance-panel-header">
          <div>
            <span>DISPLAY</span>
            <h2 id={panelTitleId}>外观设置</h2>
          </div>
          <button
            type="button"
            className="appearance-panel-close"
            aria-label="关闭外观设置"
            onClick={() => {
              restoreFocusRef.current = true;
              setOpen(false);
            }}
          >
            <CloseIcon />
          </button>
        </header>

        <div
          className="appearance-panel-tabs"
          role="tablist"
          aria-label="设置类别"
        >
          <button
            type="button"
            role="tab"
            aria-selected={appearanceView === "color"}
            className={appearanceView === "color" ? "active" : ""}
            onClick={() => setAppearanceView("color")}
          >
            颜色
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={appearanceView === "background"}
            className={appearanceView === "background" ? "active" : ""}
            onClick={() => setAppearanceView("background")}
          >
            背景
          </button>
        </div>

        {appearanceView === "color" ? (
          <section
            className="appearance-section theme-color-section"
            aria-labelledby={colorSectionId}
          >
          <div className="appearance-section-heading">
            <div>
              <p className="bg-control-title" id={colorSectionId}>
                全局颜色
              </p>
              <p className="appearance-source">{sourceLabel}</p>
            </div>
            <button
              type="button"
              className="bg-control-reset"
              disabled={!storedTheme}
              aria-label="恢复站点默认颜色"
              onClick={resetTheme}
            >
              恢复默认
            </button>
          </div>

          <div className="theme-preview" aria-live="polite">
            <div className="theme-preview-colors" aria-hidden="true">
              <span
                className="theme-preview-swatch"
                style={{ background: effectiveTheme.base }}
              />
              <span
                className="theme-preview-swatch readable"
                style={{ background: effectiveTheme.readable }}
              />
            </div>
            <div className="theme-preview-data">
              <span>
                原始色 <code>{effectiveTheme.base}</code>
              </span>
              <span>
                可读色 <code>{effectiveTheme.readable}</code>
              </span>
              <strong>{effectiveTheme.contrast.toFixed(2)} : 1</strong>
            </div>
          </div>

          <div
            className="theme-editor-tabs"
            role="tablist"
            aria-label="颜色选择方式"
          >
            <button
              type="button"
              role="tab"
              aria-selected={colorEditor === "presets"}
              className={colorEditor === "presets" ? "active" : ""}
              onClick={() => setColorEditor("presets")}
            >
              ColorChecker
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={colorEditor === "custom"}
              className={colorEditor === "custom" ? "active" : ""}
              onClick={openCustomEditor}
            >
              HSV 自定义
            </button>
          </div>

          {colorEditor === "presets" ? (
            <div className="color-checker-picker">
              <div
                className="color-checker-grid"
                id={colorCheckerId}
                role="group"
                aria-label={`ColorChecker 24 色预设，当前显示 ${visibleColorCheckerPresets.length} 色`}
                onPointerLeave={() => setInspectedPresetId(null)}
                onBlur={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  ) {
                    setInspectedPresetId(null);
                  }
                }}
              >
                {visibleColorCheckerPresets.map((preset) => {
                  const isActive = activePresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={isActive ? "active" : ""}
                      aria-pressed={isActive}
                      aria-label={`${preset.name} ${preset.hex}`}
                      aria-describedby={`${colorCheckerId}-readout`}
                      title={`${preset.name} · ${preset.hex}`}
                      style={
                        {
                          "--swatch-color": preset.hex,
                          "--swatch-ink": chooseOnAccent(preset.hex),
                        } as CSSProperties
                      }
                      onPointerEnter={() => setInspectedPresetId(preset.id)}
                      onFocus={() => setInspectedPresetId(preset.id)}
                      onClick={() => selectPreset(preset.id)}
                    >
                      <span aria-hidden="true">{preset.name}</span>
                    </button>
                  );
                })}
              </div>

              <div className="color-checker-footer">
                <div
                  className="color-checker-readout"
                  id={`${colorCheckerId}-readout`}
                  aria-live="polite"
                >
                  <span
                    className="color-checker-readout-swatch"
                    style={{ background: inspectedPreset.hex }}
                    aria-hidden="true"
                  />
                  <strong>{inspectedPreset.name}</strong>
                  <code>{inspectedPreset.hex}</code>
                </div>

                <button
                  type="button"
                  className="color-checker-fold"
                  aria-expanded={colorCheckerExpanded}
                  aria-controls={colorCheckerId}
                  onClick={() =>
                    setColorCheckerExpanded((expanded) => !expanded)
                  }
                >
                  <span>
                    {colorCheckerExpanded ? "收起" : "展开"}
                  </span>
                  <span aria-hidden="true">
                    {visibleColorCheckerPresets.length}/24
                  </span>
                </button>
              </div>
            </div>
          ) : (
            <div className="hsv-picker">
              <div
                className="color-encoding-preview"
                role="group"
                aria-label="当前自定义颜色的 sRGB 与 Rec.709 编码预览"
              >
                <div className="color-encoding-card">
                  <div
                    className="color-encoding-window"
                    style={
                      {
                        "--encoding-color": customHex,
                        "--encoding-ink": chooseOnAccent(customHex),
                      } as CSSProperties
                    }
                    aria-hidden="true"
                  >
                    <span>sRGB</span>
                  </div>
                  <div className="color-encoding-data">
                    <strong>sRGB</strong>
                    <code>{customHex}</code>
                  </div>
                </div>

                <div className="color-encoding-card">
                  <div
                    className="color-encoding-window"
                    style={
                      {
                        "--encoding-color": rec709Hex,
                        "--encoding-ink": chooseOnAccent(rec709Hex),
                      } as CSSProperties
                    }
                    aria-hidden="true"
                  >
                    <span>REC.709</span>
                  </div>
                  <div className="color-encoding-data">
                    <strong>REC.709</strong>
                    <code>{rec709Hex}</code>
                  </div>
                </div>
              </div>
              <p className="color-encoding-note">
                同一线性 RGB 的编码值对照；REC.709 由浏览器近似显示。
              </p>

              <button
                type="button"
                className="sv-plane"
                aria-label={`饱和度 ${customHsv.s}%，明度 ${customHsv.v}%。使用方向键调整，按住 Shift 每次调整 10%。`}
                style={{ "--picker-hue": customHsv.h } as CSSProperties}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  updateSaturationValue(event);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    updateSaturationValue(event);
                  }
                }}
                onKeyDown={onSaturationValueKeyDown}
              >
                <span
                  className="sv-plane-handle"
                  style={{
                    left: `${customHsv.s}%`,
                    top: `${100 - customHsv.v}%`,
                    background: customHex,
                  }}
                  aria-hidden="true"
                />
              </button>

              <div className="hsv-hue-control">
                <div className="bg-control-header">
                  <label htmlFor={`${panelId}-hue`}>Hue</label>
                  <output>{customHsv.h}°</output>
                </div>
                <input
                  id={`${panelId}-hue`}
                  className="hue-slider"
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={customHsv.h}
                  style={{ "--picker-hue": customHsv.h } as CSSProperties}
                  onChange={(event) =>
                    updateCustomColor({
                      ...customHsv,
                      h: Number(event.target.value),
                    })
                  }
                />
              </div>

              <div className="hsv-number-grid">
                {(
                  [
                    ["h", "H", 0, 359],
                    ["s", "S", 0, 100],
                    ["v", "V", 0, 100],
                  ] as const
                ).map(([channel, label, min, max]) => (
                  <label key={channel}>
                    <span>{label}</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={min}
                      max={max}
                      step={1}
                      value={customHsv[channel]}
                      onChange={(event) =>
                        updateCustomColor({
                          ...customHsv,
                          [channel]: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                ))}
                <div className="hsv-hex-output">
                  <span>HEX</span>
                  <output>{customHex}</output>
                </div>
              </div>
            </div>
          )}

          {colorEditor === "custom" && effectiveTheme.adjusted ? (
            <p className="theme-adjustment-note">
              原始色保持不变；文字与焦点使用自动派生的可读色。
            </p>
          ) : null}
          </section>
        ) : (
          <section
            className="appearance-section background-section"
            aria-labelledby={backgroundSectionId}
          >
          <div className="appearance-section-heading">
            <p className="bg-control-title" id={backgroundSectionId}>
              背景样式
            </p>
            <button
              type="button"
              className="bg-control-reset"
              aria-label="恢复背景默认"
              onClick={resetBackground}
            >
              恢复默认
            </button>
          </div>

          <div
            className="bg-control-modes"
            role="radiogroup"
            aria-label="背景样式"
          >
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
                  尚未配置背景图：请在 Directus 的 site_settings 中上传
                  background_image / background_images。
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
                    <label htmlFor={`${panelId}-blur`}>背景模糊</label>
                    <output>{blur}px</output>
                  </div>
                  <input
                    id={`${panelId}-blur`}
                    type="range"
                    min={MIN_BLUR}
                    max={MAX_BLUR}
                    step={1}
                    value={blur}
                    onChange={(event) =>
                      updateBlur(Number(event.target.value))
                    }
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p className="bg-control-note">
              首页跟随全局颜色；文章与视频栏目保留各自固定背景。
            </p>
          )}
          </section>
        )}
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
                } as CSSProperties
              }
              aria-hidden="true"
            />,
            document.body
          )
        : null}
    </div>
  );

  if (isHome) {
    return mounted ? createPortal(control, document.body) : null;
  }

  return control;
}

function SlidersIcon() {
  return (
    <svg
      width="17"
      height="17"
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

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
