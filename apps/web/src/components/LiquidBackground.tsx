"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { createLiquidFluidRenderer, type LiquidFluidController, type LiquidVariant } from "@/lib/liquid-fluid";
import { LIQUID_PREFERENCES_EVENT, LIQUID_STORAGE_KEY, defaultLiquidPreferences, liquidPaletteFromSettings, resolveLiquidPreferences, type LiquidPreferences } from "@/lib/liquid-preferences";
import { liquidReadingScale, liquidRouteActive } from "@/lib/viewing";

function readStoredPreferences() {
  try { return resolveLiquidPreferences(window.localStorage.getItem(LIQUID_STORAGE_KEY)).settings; }
  catch { return defaultLiquidPreferences(); }
}

/**
 * Mounted once in the root layout, outside PageTransition's route key, so navigation
 * never restarts the simulation. Route speed is an ephemeral multiplier; saved
 * appearance values stay untouched.
 */
export function LiquidBackground({ variant = "gray" }: { variant?: LiquidVariant }) {
  const pathname = usePathname() || "/";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<LiquidFluidController | null>(null);
  const [renderer, setRenderer] = useState<"css" | "webgl">("css");
  const [preferences, setPreferences] = useState<LiquidPreferences | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const active = everywhere || liquidRouteActive(pathname);
  const speed = fullscreen || !active ? 0 : (preferences?.speed ?? 0) * liquidReadingScale(pathname);

  useEffect(() => {
    setPreferences(readStoredPreferences());
    const receivePreferences = (event: Event) => {
      if (event instanceof CustomEvent) setPreferences(resolveLiquidPreferences(JSON.stringify(event.detail)).settings);
    };
    const receiveStorage = (event: StorageEvent) => {
      if (event.key === LIQUID_STORAGE_KEY || event.key === null) setPreferences(readStoredPreferences());
    };
    const watching = () => {
      setFullscreen(document.documentElement.dataset.watching === "fullscreen");
      setEverywhere(document.documentElement.hasAttribute("data-liquid-everywhere"));
    };
    const observer = new MutationObserver(watching);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-watching", "data-liquid-everywhere"] });
    watching();
    window.addEventListener(LIQUID_PREFERENCES_EVENT, receivePreferences);
    window.addEventListener("storage", receiveStorage);
    return () => { observer.disconnect(); window.removeEventListener(LIQUID_PREFERENCES_EVENT, receivePreferences); window.removeEventListener("storage", receiveStorage); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches) return;
    try {
      controllerRef.current = createLiquidFluidRenderer(canvas, {
        variant, speed: 0, palette: liquidPaletteFromSettings(readStoredPreferences()),
        onContextLost: () => { controllerRef.current?.dispose(); controllerRef.current = null; setRenderer("css"); },
      });
    } catch { controllerRef.current = null; }
    if (controllerRef.current) setRenderer("webgl");
    const reduce = (event: MediaQueryListEvent) => {
      if (event.matches) { controllerRef.current?.dispose(); controllerRef.current = null; setRenderer("css"); }
    };
    reducedMotion.addEventListener("change", reduce);
    return () => { reducedMotion.removeEventListener("change", reduce); controllerRef.current?.dispose(); controllerRef.current = null; };
  }, [variant]);

  // Update the live renderer instead of rebuilding its simulation and flashing
  // a new initial frame.
  useEffect(() => {
    if (preferences) controllerRef.current?.update({ speed, palette: liquidPaletteFromSettings(preferences) });
  }, [speed, preferences, variant]);

  // Inherit bootstrap-applied preferences even before hydration: a saved zero
  // speed must never be overridden by server defaults for the CSS fallback.
  const durations = {
    "--liquid-route-scale": liquidReadingScale(pathname),
    "--liquid-watching-play-state": fullscreen ? "paused" : "var(--liquid-play-state, running)",
  } as CSSProperties;
  return <div className="liquid-bg" data-liquid-active={active} data-liquid-renderer={renderer} data-liquid-speed={speed} style={durations} aria-hidden="true">
    <canvas ref={canvasRef} className="liquid-canvas" />
    <div className="liquid-blobs">{[1, 2, 3, 4, 5, 6].map(index => <div key={index} className={`blob blob-${index}`} />)}</div>
    <div className="liquid-grain" />
  </div>;
}
