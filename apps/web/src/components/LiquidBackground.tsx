"use client";

import { useEffect, useRef, useState } from "react";
import {
  createLiquidFluidRenderer,
  type LiquidFluidController,
  type LiquidVariant,
} from "@/lib/liquid-fluid";
import {
  LIQUID_PREFERENCES_EVENT,
  LIQUID_STORAGE_KEY,
  defaultLiquidPreferences,
  liquidPaletteFromSettings,
  resolveLiquidPreferences,
  type LiquidPreferences,
} from "@/lib/liquid-preferences";

function readStoredPreferences(): LiquidPreferences {
  try {
    return resolveLiquidPreferences(
      window.localStorage.getItem(LIQUID_STORAGE_KEY),
    ).settings;
  } catch {
    return defaultLiquidPreferences();
  }
}

/**
 * A low-resolution fluid renderer with the existing CSS blob layer as a
 * graceful fallback for unsupported or intentionally reduced-motion devices.
 */
export function LiquidBackground({
  variant = "gray",
}: {
  variant?: LiquidVariant;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<"css" | "webgl">("css");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    if (reducedMotion.matches) return;

    const initial = readStoredPreferences();
    let controller: LiquidFluidController | null = null;

    const updateController = (settings: LiquidPreferences) => {
      controller?.update({
        speed: settings.speed,
        palette: liquidPaletteFromSettings(settings),
      });
    };

    try {
      controller = createLiquidFluidRenderer(canvas, {
        variant,
        speed: initial.speed,
        palette: liquidPaletteFromSettings(initial),
        onContextLost: () => {
          controller?.dispose();
          controller = null;
          setRenderer("css");
        },
      });
    } catch {
      controller = null;
    }

    if (!controller) return;
    setRenderer("webgl");

    const receivePreferences = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const next = resolveLiquidPreferences(JSON.stringify(event.detail)).settings;
      updateController(next);
    };
    const receiveStorage = (event: StorageEvent) => {
      if (event.key !== LIQUID_STORAGE_KEY && event.key !== null) return;
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      updateController(readStoredPreferences());
    };
    const receiveReducedMotion = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      controller?.dispose();
      controller = null;
      setRenderer("css");
    };

    window.addEventListener(
      LIQUID_PREFERENCES_EVENT,
      receivePreferences,
    );
    window.addEventListener("storage", receiveStorage);
    reducedMotion.addEventListener("change", receiveReducedMotion);

    return () => {
      window.removeEventListener(
        LIQUID_PREFERENCES_EVENT,
        receivePreferences,
      );
      window.removeEventListener("storage", receiveStorage);
      reducedMotion.removeEventListener("change", receiveReducedMotion);
      controller?.dispose();
    };
  }, [variant]);

  return (
    <div
      className="liquid-bg"
      data-liquid-renderer={renderer}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="liquid-canvas" />

      <div className="liquid-blobs">
        <div className="blob blob-1" />
        <div className="blob blob-2" />
        <div className="blob blob-3" />
      </div>

      <div className="liquid-grain" />
    </div>
  );
}
