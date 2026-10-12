"use client";

import dynamic from "next/dynamic";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { GaussianSplatConfig } from "@/lib/gaussian-splat";
import type { GaussianSplatRenderState } from "./GaussianSplatCanvas";

type GaussianSplatEmbedProps = {
  config: GaussianSplatConfig;
};

const GaussianSplatCanvas = dynamic(
  () => import("./GaussianSplatCanvas").then((module) => module.GaussianSplatCanvas),
  { ssr: false },
);

const INITIAL_RENDER_STATE: GaussianSplatRenderState = {
  phase: "loading",
  progress: 0,
};

export function GaussianSplatEmbed({ config }: GaussianSplatEmbedProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [renderState, setRenderState] =
    useState<GaussianSplatRenderState>(INITIAL_RENDER_STATE);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === viewportRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const handleRenderState = useCallback((state: GaussianSplatRenderState) => {
    setRenderState(state);
  }, []);

  const activate = () => {
    setRenderState(INITIAL_RENDER_STATE);
    setActive(true);
  };

  const retry = () => {
    setRenderState(INITIAL_RENDER_STATE);
    setSceneKey((value) => value + 1);
  };

  const toggleFullscreen = async () => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    try {
      if (document.fullscreenElement === viewport) {
        await document.exitFullscreen();
      } else if (viewport.requestFullscreen) {
        await viewport.requestFullscreen();
      }
    } catch {
      // Browsers may decline fullscreen when it is unavailable or policy-blocked.
    }
  };

  const progressPercent = Math.round(
    Math.min(1, Math.max(0, renderState.progress || 0)) * 100,
  );

  return (
    <figure
      className="gaussian-splat-embed"
      style={
        {
          "--splat-height": `${config.height}px`,
          "--splat-background": config.background,
        } as CSSProperties
      }
    >
      <div
        className="gaussian-splat-viewport"
        ref={viewportRef}
        role="region"
        aria-label={`${config.title} interactive 3D Gaussian splat`}
        aria-busy={active && renderState.phase === "loading"}
      >
        {!active ? (
          <button
            className="gaussian-splat-launch"
            onClick={activate}
            type="button"
            aria-label={`Load interactive 3D scene: ${config.title}`}
          >
            {config.poster ? (
              <img src={config.poster} alt="" loading="lazy" />
            ) : (
              <span className="gaussian-splat-grid" aria-hidden="true" />
            )}
            <span className="gaussian-splat-launch-shade" aria-hidden="true" />
            <span className="gaussian-splat-launch-copy">
              <span className="gaussian-splat-launch-icon" aria-hidden="true">
                <PlayIcon />
              </span>
              <span>
                <strong>Explore in 3D</strong>
                <small>Click to load the interactive scene</small>
              </span>
            </span>
          </button>
        ) : (
          <>
            <GaussianSplatCanvas
              config={config}
              key={sceneKey}
              onRenderState={handleRenderState}
            />

            {renderState.phase === "loading" ? (
              <div className="gaussian-splat-loading" role="status">
                <span className="gaussian-splat-loading-mark" aria-hidden="true" />
                <span>
                  <strong>Loading splats</strong>
                  <small>
                    {progressPercent > 0 ? `${progressPercent}%` : "Preparing renderer"}
                  </small>
                </span>
              </div>
            ) : null}

            {renderState.phase === "error" ? (
              <div className="gaussian-splat-error" role="alert">
                <p className="eyebrow">3D scene unavailable</p>
                <strong>Unable to load this Gaussian splat.</strong>
                <small>{renderState.message}</small>
                <div>
                  <button type="button" onClick={retry}>
                    Retry
                  </button>
                  <a href={config.src} target="_blank" rel="noreferrer">
                    Open source
                  </a>
                </div>
              </div>
            ) : null}
          </>
        )}

        <div className="gaussian-splat-head">
          <span className="gaussian-splat-format">
            <span aria-hidden="true" />
            3DGS
          </span>
          <strong>{config.title}</strong>
        </div>

        {active && renderState.phase !== "error" ? (
          <div className="gaussian-splat-toolbar">
            <span>Drag to orbit · Right-drag to pan · Scroll to zoom</span>
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit full screen" : "View full screen"}
            >
              <FullscreenIcon active={isFullscreen} />
              <span>{isFullscreen ? "Exit" : "Full screen"}</span>
            </button>
          </div>
        ) : null}
      </div>

      <figcaption>
        <span>Interactive Gaussian Splat</span>
        <span>SOG / PLY · WebGL</span>
      </figcaption>
    </figure>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 7 8 5-8 5V7Z" fill="currentColor" />
    </svg>
  );
}

function FullscreenIcon({ active }: { active: boolean }) {
  return active ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
    </svg>
  );
}
