"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VideoMaster } from "@/lib/directus";
import { masterResolution, mediaUrl } from "@/lib/directus";

type MediaPlayerProps = {
  masters: VideoMaster[];
  poster?: string | null;
};

type PlaybackState = "idle" | "loading" | "ready" | "playing" | "paused" | "error";

type DeviceCapabilities = {
  hdr: boolean;
  p3: boolean;
  rec2020: boolean;
  hevc: boolean;
  nativeHls: boolean;
};

type ShakaPlayer = {
  configure(config: unknown): void;
  load(source: string): Promise<void>;
  destroy(): Promise<void>;
  addEventListener(type: string, listener: (event: Event & { detail?: unknown }) => void): void;
};

type ShakaNamespace = {
  polyfill: {
    installAll(): void;
  };
  Player: {
    new (video: HTMLVideoElement): ShakaPlayer;
    isBrowserSupported(): boolean;
  };
};

export function MediaPlayer({ masters, poster }: MediaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<ShakaPlayer | null>(null);
  const currentMasterRef = useRef<VideoMaster | null>(null);
  const fallbackAttemptedRef = useRef(false);
  const mountedRef = useRef(true);

  const [activeMasterId, setActiveMasterId] = useState(() => getDefaultMaster(masters)?.id);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);

  const activeMaster = useMemo(
    () => masters.find((master) => master.id === activeMasterId) || getDefaultMaster(masters),
    [activeMasterId, masters],
  );

  const defaultMaster = useMemo(() => getDefaultMaster(masters), [masters]);
  const sdrFallback = useMemo(
    () => masters.find((master) => master.type === "sdr") || defaultMaster,
    [defaultMaster, masters],
  );

  /* ---- Device capability detection ---- */
  useEffect(() => {
    setCapabilities(detectCapabilities());
  }, []);

  /* ---- Mount / unmount guard ---- */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ---- Native video events ---- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => setPlaybackState("playing");
    const onPause = () => setPlaybackState("paused");
    const onWaiting = () => {
      if (playbackState === "playing") setPlaybackState("loading");
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
    };
  }, [playbackState]);

  /* ---- Load active master ---- */
  useEffect(() => {
    let cancelled = false;

    async function loadMaster() {
      const video = videoRef.current;
      if (!video || !activeMaster) return;

      const previousTime = video.currentTime || 0;
      const wasPlaying = !video.paused;
      const source = mediaUrl(activeMaster.hls_url);

      currentMasterRef.current = activeMaster;
      if (mountedRef.current) {
        setPlaybackState("loading");
        setError(null);
      }

      try {
        const shakaModule = await import("shaka-player/dist/shaka-player.compiled.js");
        const shaka = (
          "default" in shakaModule ? shakaModule.default : shakaModule
        ) as ShakaNamespace;

        if (cancelled || !mountedRef.current) return;

        shaka.polyfill.installAll();

        if (!shaka.Player.isBrowserSupported()) {
          throw new Error("This browser is not supported by Shaka Player.");
        }

        if (!playerRef.current) {
          const player = new shaka.Player(video);
          player.configure({
            streaming: {
              retryParameters: {
                maxAttempts: 2,
                baseDelay: 500,
                backoffFactor: 2,
                fuzzFactor: 0.5,
                timeout: 12000,
              },
            },
          });
          player.addEventListener("error", (event) => {
            const detail = "detail" in event ? event.detail : null;
            void handleFatalPlaybackError(detail instanceof Error ? detail : null);
          });
          playerRef.current = player;
        }

        await playerRef.current.load(source);
        if (cancelled || !mountedRef.current) return;

        if (previousTime > 0 && Number.isFinite(previousTime)) {
          video.currentTime = previousTime;
        }

        setPlaybackState(video.paused ? "ready" : "playing");

        if (wasPlaying) {
          await video.play().catch(() => {
            setPlaybackState("ready");
          });
        }
      } catch (loadError) {
        await handleFatalPlaybackError(
          loadError instanceof Error ? loadError : null,
        );
      }
    }

    void loadMaster();

    return () => {
      cancelled = true;
    };
  }, [activeMaster]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- Cleanup Shaka on unmount ---- */
  useEffect(() => {
    return () => {
      void playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  /* ---- Fatal error → SDR fallback ---- */
  const handleFatalPlaybackError = useCallback(
    async (loadError: Error | null) => {
      const failedMaster = currentMasterRef.current;
      if (!mountedRef.current) return;

      setPlaybackState("error");

      if (
        sdrFallback &&
        failedMaster &&
        sdrFallback.id !== failedMaster.id &&
        !fallbackAttemptedRef.current
      ) {
        fallbackAttemptedRef.current = true;
        setError(
          `${failedMaster.label} playback failed — falling back to ${sdrFallback.label}.`,
        );
        setActiveMasterId(sdrFallback.id);
        return;
      }

      setError(loadError?.message || "Playback failed for this master.");
    },
    [sdrFallback],
  );

  /* ---- User-initiated master switch ---- */
  const switchMaster = useCallback((master: VideoMaster) => {
    fallbackAttemptedRef.current = false;
    setActiveMasterId(master.id);
  }, []);

  /* ---- Retry after error ---- */
  const retry = useCallback(() => {
    if (activeMaster) {
      fallbackAttemptedRef.current = false;
      switchMaster(activeMaster);
    }
  }, [activeMaster, switchMaster]);

  /* ---- No masters edge case ---- */
  if (!activeMaster) {
    return (
      <div className="player-shell empty-state" role="status">
        <p>No video masters have been configured for this project.</p>
      </div>
    );
  }

  const hdrWarning =
    capabilities && isHdrMaster(activeMaster) && !capabilities.hdr
      ? "This display may not support HDR playback. Switch to SDR for a better experience."
      : null;

  const resolutionLabel = masterResolution(activeMaster);

  return (
    <section className="player-shell" aria-label="Video player">
      <div className="player-frame">
        <video
          ref={videoRef}
          className="video-player"
          controls
          playsInline
          poster={poster || undefined}
          aria-label={`Video player — ${activeMaster.label}`}
          preload="metadata"
        />
        <div
          className={`playback-badge ${playbackState}`}
          aria-live="polite"
          aria-label={`Playback status: ${playbackState}`}
        >
          {playbackState}
        </div>
      </div>

      <div className="master-bar" role="group" aria-label="Video master switcher">
        {masters.map((master) => (
          <button
            className={
              master.id === activeMaster.id
                ? "master-button active"
                : "master-button"
            }
            key={master.id}
            onClick={() => switchMaster(master)}
            type="button"
            aria-pressed={master.id === activeMaster.id}
            aria-label={`Switch to ${master.label} (${master.type.replace("_", " ")})`}
          >
            <span>{master.label}</span>
            <small>{master.type.replace("_", " ")}</small>
          </button>
        ))}
      </div>

      {hdrWarning ? (
        <p className="player-warning" role="alert">
          {hdrWarning}
        </p>
      ) : null}

      {error ? (
        <div
          className={playbackState === "error" ? "player-error" : "player-warning"}
          role="alert"
        >
          <p style={{ margin: 0 }}>{error}</p>
          {playbackState === "error" && (
            <button
              type="button"
              onClick={retry}
              className="master-button"
              style={{ marginTop: 10 }}
              aria-label="Retry playback"
            >
              Retry
            </button>
          )}
        </div>
      ) : null}

      {/* ---- Active master technical metadata ---- */}
      <dl className="tech-grid" aria-label="Current master technical details">
        <div>
          <dt>Type</dt>
          <dd>{activeMaster.type.replace("_", " ")}</dd>
        </div>
        <div>
          <dt>Codec</dt>
          <dd>{activeMaster.codec || "Unknown"}</dd>
        </div>
        <div>
          <dt>Resolution</dt>
          <dd>{resolutionLabel || "Unknown"}</dd>
        </div>
        <div>
          <dt>Color Space</dt>
          <dd>{activeMaster.color_space || "Unknown"}</dd>
        </div>
        <div>
          <dt>Transfer</dt>
          <dd>{activeMaster.transfer_function || "Unknown"}</dd>
        </div>
        <div>
          <dt>Bit Depth</dt>
          <dd>
            {activeMaster.bit_depth ? `${activeMaster.bit_depth}-bit` : "Unknown"}
          </dd>
        </div>
      </dl>

      {/* ---- Device capability hints ---- */}
      {capabilities ? (
        <dl
          className="capability-grid"
          aria-label="Device playback capability detection"
        >
          <div>
            <dt>HDR Display</dt>
            <dd>{capabilities.hdr ? "Likely" : "Not detected"}</dd>
          </div>
          <div>
            <dt>P3 Gamut</dt>
            <dd>{capabilities.p3 ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Rec.2020</dt>
            <dd>{capabilities.rec2020 ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>HEVC</dt>
            <dd>{capabilities.hevc ? "Maybe" : "Unknown"}</dd>
          </div>
          <div>
            <dt>Native HLS</dt>
            <dd>{capabilities.nativeHls ? "Yes" : "No"}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

/* ---- Helpers ---- */

function getDefaultMaster(masters: VideoMaster[]) {
  return (
    masters.find(
      (master) => master.is_default === true || master.is_default === 1,
    ) || masters[0]
  );
}

function isHdrMaster(master: VideoMaster) {
  return (
    master.type === "hdr10" ||
    master.type === "hlg" ||
    master.type === "dolby_vision"
  );
}

function detectCapabilities(): DeviceCapabilities {
  /* SSR guard */
  if (typeof window === "undefined") {
    return { hdr: false, p3: false, rec2020: false, hevc: false, nativeHls: false };
  }

  const video = document.createElement("video");
  const mediaCapabilities = navigator.mediaCapabilities;

  return {
    hdr: window.matchMedia?.("(dynamic-range: high)")?.matches || false,
    p3: window.matchMedia?.("(color-gamut: p3)")?.matches || false,
    rec2020: window.matchMedia?.("(color-gamut: rec2020)")?.matches || false,
    hevc:
      video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== "" ||
      video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== "" ||
      Boolean(mediaCapabilities),
    nativeHls:
      video.canPlayType("application/vnd.apple.mpegurl") !== "",
  };
}
