"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VideoMaster } from "@/lib/directus";
import { masterResolution, mediaUrl } from "@/lib/directus";

type MediaPlayerProps = {
  masters: VideoMaster[];
  poster?: string | null;
};

type PlaybackState = "idle" | "loading" | "ready" | "playing" | "paused" | "error";

type PlaybackSnapshot = {
  targetMasterId: number;
  requestId: number;
  time: number;
  wasPlaying: boolean;
};

type DeviceCapabilities = {
  hdr: boolean;
  p3: boolean;
  rec2020: boolean;
  hevc: boolean;
  nativeHls: boolean;
};

type ShakaPlayer = {
  configure(config: unknown): void;
  load(source: string, startTime?: number | null): Promise<void>;
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
  const polyfillInstalledRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const pendingPlaybackRef = useRef<PlaybackSnapshot | null>(null);
  const lastLoadSnapshotRef = useRef<PlaybackSnapshot | null>(null);

  const [activeMasterId, setActiveMasterId] = useState(() => getDefaultMaster(masters)?.id);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const activeMaster = useMemo(
    () => masters.find((m) => m.id === activeMasterId) ?? getDefaultMaster(masters),
    [activeMasterId, masters],
  );

  const defaultMaster = useMemo(() => getDefaultMaster(masters), [masters]);
  const sdrFallback = useMemo(
    () => masters.find((m) => m.type === "sdr") ?? defaultMaster,
    [defaultMaster, masters],
  );

  useEffect(() => {
    mountedRef.current = true;
    setCapabilities(detectCapabilities());
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => setPlaybackState("playing");
    const onPause  = () => setPlaybackState("paused");
    const onWaiting = () =>
      setPlaybackState((s) => (s === "playing" ? "loading" : s));

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
    };
  }, []);

  const capturePlaybackSnapshot = useCallback(
    (targetMasterId: number, sourceSnapshot?: PlaybackSnapshot | null): PlaybackSnapshot => {
      const video = videoRef.current;
      const requestId = loadRequestIdRef.current + 1;
      loadRequestIdRef.current = requestId;

      return {
        targetMasterId,
        requestId,
        time: sourceSnapshot?.time ?? playbackTime(video),
        wasPlaying: sourceSnapshot?.wasPlaying ?? Boolean(video && !video.paused && !video.ended),
      };
    },
    [],
  );

  const handleFatalPlaybackError = useCallback(
    async (loadError: Error | null) => {
      const failedMaster = currentMasterRef.current;
      const failedSnapshot = lastLoadSnapshotRef.current;
      if (!mountedRef.current) return;

      setPlaybackState("error");

      if (
        sdrFallback &&
        failedMaster &&
        sdrFallback.id !== failedMaster.id &&
        !fallbackAttemptedRef.current
      ) {
        fallbackAttemptedRef.current = true;
        pendingPlaybackRef.current = capturePlaybackSnapshot(sdrFallback.id, failedSnapshot);
        setError(`${failedMaster.label} playback failed. Falling back to ${sdrFallback.label}.`);
        setActiveMasterId(sdrFallback.id);
        return;
      }

      setError(loadError?.message || "Playback failed for this master.");
    },
    [capturePlaybackSnapshot, sdrFallback],
  );

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;

    async function loadMaster() {
      const video = videoRef.current;
      if (!video || !activeMaster) return;

      const pendingSnapshot = pendingPlaybackRef.current;
      const snapshot =
        pendingSnapshot?.targetMasterId === activeMaster.id
          ? pendingSnapshot
          : capturePlaybackSnapshot(activeMaster.id);
      const source = mediaUrl(activeMaster.hls_url);

      if (pendingSnapshot?.targetMasterId === activeMaster.id) {
        pendingPlaybackRef.current = null;
      }

      lastLoadSnapshotRef.current = snapshot;
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

        if (!polyfillInstalledRef.current) {
          shaka.polyfill.installAll();
          polyfillInstalledRef.current = true;
        }

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

        await playerRef.current.load(source, snapshot.time > 0 ? snapshot.time : null);
        if (
          cancelled ||
          !mountedRef.current ||
          snapshot.requestId !== loadRequestIdRef.current
        ) {
          return;
        }

        if (snapshot.time > 0 && Number.isFinite(snapshot.time)) {
          const nextTime = clampPlaybackTime(snapshot.time, video.duration);
          if (Math.abs(video.currentTime - nextTime) > 0.35) {
            video.currentTime = nextTime;
          }
        }

        if (snapshot.wasPlaying) {
          await video
            .play()
            .then(() => setPlaybackState("playing"))
            .catch(() => setPlaybackState("ready"));
        } else {
          setPlaybackState(video.paused ? "ready" : "playing");
        }
      } catch (loadError) {
        if (
          cancelled ||
          !mountedRef.current ||
          snapshot.requestId !== loadRequestIdRef.current
        ) {
          return;
        }

        await handleFatalPlaybackError(loadError instanceof Error ? loadError : null);
      }
    }

    void loadMaster();
    return () => { cancelled = true; };
  }, [activeMaster, capturePlaybackSnapshot, handleFatalPlaybackError, reloadNonce]);

  useEffect(() => {
    return () => {
      void playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  const switchMaster = useCallback((master: VideoMaster) => {
    if (master.id === activeMasterId) return;

    fallbackAttemptedRef.current = false;
    pendingPlaybackRef.current = capturePlaybackSnapshot(master.id);
    setActiveMasterId(master.id);
  }, [activeMasterId, capturePlaybackSnapshot]);

  const retry = useCallback(() => {
    if (activeMaster) {
      fallbackAttemptedRef.current = false;
      pendingPlaybackRef.current = capturePlaybackSnapshot(activeMaster.id);
      setReloadNonce((value) => value + 1);
    }
  }, [activeMaster, capturePlaybackSnapshot]);

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
  const dolbyProfileVersion = formatDolbyProfileVersion(
    activeMaster.dolby_profile,
    activeMaster.dolby_compatibility_id,
  );

  return (
    <section className="player-shell" aria-label="Video player">
      <div className={infoOpen ? "player-layout info-open" : "player-layout"}>
        <div className="player-main">
          <div className="player-frame" data-state={playbackState}>
            <video
              ref={videoRef}
              className="video-player"
              controls
              playsInline
              poster={poster || undefined}
              aria-label={`Video player - ${activeMaster.label}`}
              preload="metadata"
            />
          </div>

          <div className="player-controls-row">
            <div className="master-bar" role="group" aria-label="Video master switcher">
              {masters.map((master) => (
                <button
                  className={
                    master.id === activeMaster.id ? "master-button active" : "master-button"
                  }
                  key={master.id}
                  onClick={() => switchMaster(master)}
                  type="button"
                  aria-pressed={master.id === activeMaster.id}
                  aria-label={`Switch to ${master.label} (${master.type.replace("_", " ")})`}
                >
                  <span
                    className={`master-dot master-dot-${master.type}`}
                    aria-hidden="true"
                  />
                  <span className="master-button-label">
                    <span>{master.label}</span>
                    <small>{master.type.replace(/_/g, " ")}</small>
                  </span>
                </button>
              ))}
            </div>

            <button
              className={infoOpen ? "info-toggle active" : "info-toggle"}
              onClick={() => setInfoOpen((open) => !open)}
              type="button"
              aria-expanded={infoOpen}
              aria-controls="player-info-panel"
            >
              {infoOpen ? "Hide Info" : "Show Info"}
            </button>
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
              <p>{error}</p>
              {playbackState === "error" ? (
                <button
                  type="button"
                  onClick={retry}
                  className="retry-button"
                  aria-label="Retry playback"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="player-info-sidebar">
        <aside
          className={infoOpen ? "player-info-panel open" : "player-info-panel"}
          id="player-info-panel"
          aria-hidden={!infoOpen}
        >
          <div className="info-panel-header">
            <div>
              <p className="eyebrow">Playback Info</p>
              <h2>{activeMaster.label}</h2>
            </div>
            <button
              className="info-close"
              onClick={() => setInfoOpen(false)}
              type="button"
              aria-label="Close info panel"
            >
              Close
            </button>
          </div>

          <div className="info-section">
            <h3>Current Master</h3>
            <dl className="tech-grid" aria-label="Current master technical details">
              <div><dt>Type</dt><dd>{activeMaster.type.replace(/_/g, " ")}</dd></div>
              <div><dt>Codec</dt><dd>{activeMaster.codec || "N/A"}</dd></div>
              <div><dt>Resolution</dt><dd>{resolutionLabel || "N/A"}</dd></div>
              <div><dt>Color Space</dt><dd>{activeMaster.color_space || "N/A"}</dd></div>
              <div><dt>Transfer</dt><dd>{activeMaster.transfer_function || "N/A"}</dd></div>
              <div>
                <dt>Bit Depth</dt>
                <dd>{activeMaster.bit_depth ? `${activeMaster.bit_depth}-bit` : "N/A"}</dd>
              </div>
              {activeMaster.type === "dolby_vision" ? (
                <>
                  <div><dt>DV Profile Version</dt><dd>{dolbyProfileVersion || "N/A"}</dd></div>
                  <div><dt>DV Level</dt><dd>{activeMaster.dolby_level || "N/A"}</dd></div>
                  <div><dt>Compat.</dt><dd>{activeMaster.dolby_compatibility_id || "N/A"}</dd></div>
                  <div><dt>RPU</dt><dd>{formatPresent(activeMaster.dolby_rpu_present)}</dd></div>
                  <div><dt>EL</dt><dd>{formatPresent(activeMaster.dolby_el_present)}</dd></div>
                  <div><dt>BL</dt><dd>{formatPresent(activeMaster.dolby_bl_present)}</dd></div>
                </>
              ) : null}
            </dl>
          </div>

          {capabilities ? (
            <div className="info-section">
              <h3>Device</h3>
              <dl className="capability-grid" aria-label="Device playback capability detection">
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
            </div>
          ) : null}
        </aside>
        </div>
      </div>
    </section>
  );
}

function getDefaultMaster(masters: VideoMaster[]) {
  return (
    masters.find((m) => m.is_default === true || m.is_default === 1) ?? masters[0]
  );
}

function isHdrMaster(master: VideoMaster) {
  return (
    master.type === "hdr10" ||
    master.type === "hlg" ||
    master.type === "dolby_vision"
  );
}

function formatPresent(value: boolean | number | null) {
  if (value === null || value === undefined) return "N/A";
  return value === true || value === 1 ? "Yes" : "No";
}

function playbackTime(video: HTMLVideoElement | null) {
  if (!video || !Number.isFinite(video.currentTime)) return 0;
  return Math.max(video.currentTime, 0);
}

function clampPlaybackTime(time: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return time;
  return Math.min(time, Math.max(duration - 0.25, 0));
}

function formatDolbyProfileVersion(profile: string | null, compatibilityId: string | null) {
  const normalizedProfile = normalizeNumberLabel(profile);
  if (!normalizedProfile) return null;

  if (normalizedProfile.includes(".")) {
    return normalizedProfile;
  }

  if (normalizedProfile === "8") {
    const normalizedCompatibility = normalizeNumberLabel(compatibilityId);
    if (normalizedCompatibility === "1") return "8.1";
    if (normalizedCompatibility === "2") return "8.2";
    if (normalizedCompatibility === "4") return "8.4";
  }

  return normalizedProfile;
}

function normalizeNumberLabel(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  const match = text.match(/[0-9]+(?:\.[0-9]+)?/);
  if (!match) return text;

  return match[0]
    .split(".")
    .map((part) => String(Number(part)))
    .join(".");
}

function detectCapabilities(): DeviceCapabilities {
  if (typeof window === "undefined") {
    return { hdr: false, p3: false, rec2020: false, hevc: false, nativeHls: false };
  }

  const video = document.createElement("video");

  return {
    hdr: window.matchMedia?.("(dynamic-range: high)")?.matches ?? false,
    p3: window.matchMedia?.("(color-gamut: p3)")?.matches ?? false,
    rec2020: window.matchMedia?.("(color-gamut: rec2020)")?.matches ?? false,
    hevc:
      video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== "" ||
      video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== "",
    nativeHls: video.canPlayType("application/vnd.apple.mpegurl") !== "",
  };
}
