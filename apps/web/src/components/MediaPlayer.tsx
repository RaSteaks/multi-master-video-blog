"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trackAnalyticsEvent } from "@/components/AnalyticsTracker";
import type { VideoMaster } from "@/lib/directus";
import { masterResolution, mediaUrl } from "@/lib/directus";
import { getDefaultMaster, getSdrFallback, isPlayableMaster, isSdrMaster, playbackErrorMessage } from "@/lib/video-playback";
import { isHdrVideo, selectAutomaticMaster } from "@/lib/video-capabilities";
import { playbackFormat, resolveSourceFormat, sourceFormatLabel, dolbyPlaybackLabel } from "@/lib/video-format";
import { VideoFormatInfo } from "./VideoFormatInfo";
import formatStyles from "./VideoFormatInfo.module.css";

type MediaPlayerProps = {
  masters: VideoMaster[];
  poster?: string | null;
  videoProjectId?: number;
  addMaster?: { href: string; label: string };
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

export function MediaPlayer({ masters, poster, videoProjectId, addMaster }: MediaPlayerProps) {
  const playableMasters = useMemo(() => masters.filter(isPlayableMaster), [masters]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<ShakaPlayer | null>(null);
  const playerVideoRef = useRef<HTMLVideoElement | null>(null);
  const currentMasterRef = useRef<VideoMaster | null>(null);
  const fallbackAttemptedRef = useRef(false);
  const mountedRef = useRef(true);
  const polyfillInstalledRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const pendingPlaybackRef = useRef<PlaybackSnapshot | null>(null);
  const lastLoadSnapshotRef = useRef<PlaybackSnapshot | null>(null);
  const loadingMasterRef = useRef(false);
  const trackedPlaysRef = useRef(new Set<number>());
  const playbackErrorHandlerRef = useRef<(error: unknown) => Promise<void>>(async () => {});
  const manualSelectionRef = useRef(false);
  const [selectionReady, setSelectionReady] = useState(false);

  const [activeMasterId, setActiveMasterId] = useState(() => getDefaultMaster(playableMasters)?.id);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [playbackNotice, setPlaybackNotice] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const activeMaster = useMemo(
    () => playableMasters.find((m) => m.id === activeMasterId),
    [activeMasterId, playableMasters],
  );

  useEffect(() => {
    // Navigating to a different project starts a fresh automatic selection.
    manualSelectionRef.current = false;
    fallbackAttemptedRef.current = false;
  }, [videoProjectId]);

  useEffect(() => {
    if (manualSelectionRef.current) return;
    const controller = new AbortController();
    let cancelled = false;
    const probe = document.createElement("video");
    const device = detectCapabilities();
    // A slow manifest must use the same SDR fallback as completed capability detection.
    const fallback = getDefaultMaster(playableMasters.filter(isSdrMaster));
    setSelectionReady(false);
    setPlaybackState("loading");
    const timer = setTimeout(() => {
      controller.abort();
      if (!cancelled && !manualSelectionRef.current) { setActiveMasterId(fallback?.id); setSelectionReady(true); }
    }, 5000);
    void selectAutomaticMaster(playableMasters, {
      hdrDisplay: device.hdr, nativeHls: device.nativeHls,
      canPlayType: type => probe.canPlayType(type),
      mseSupports: type => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type),
      decodingInfo: navigator.mediaCapabilities?.decodingInfo?.bind(navigator.mediaCapabilities),
      manifest: async (master, signal) => {
        const response = await fetch(mediaUrl(master.hls_url), { signal });
        if (!response.ok) throw new Error("Manifest unavailable");
        const text = await response.text();
        if (text.length > 131072) throw new Error("Manifest too large");
        return text;
      }
    }, controller.signal).then(selected => {
      if (cancelled || controller.signal.aborted || manualSelectionRef.current) return;
      setActiveMasterId(selected?.id); setSelectionReady(true);
    }).finally(() => clearTimeout(timer));
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [playableMasters]);

  useEffect(() => {
    mountedRef.current = true;
    setCapabilities(detectCapabilities());
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => {
      setPlaybackState("playing");
      if (lastLoadSnapshotRef.current) lastLoadSnapshotRef.current.wasPlaying = true;
      const master = currentMasterRef.current;
      if (!videoProjectId || !master || trackedPlaysRef.current.has(master.id)) {
        return;
      }

      trackedPlaysRef.current.add(master.id);
      trackAnalyticsEvent({
        eventType: "play",
        itemType: "video",
        itemId: videoProjectId,
        masterId: master.id,
        dedupeKey: `play:video:${videoProjectId}:${master.id}`,
        dedupeMs: 2000,
      });
    };
    const onPause = () => {
      setPlaybackState("paused");
      if (!video.error && !loadingMasterRef.current && lastLoadSnapshotRef.current) {
        lastLoadSnapshotRef.current.wasPlaying = false;
      }
    };
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
  }, [videoProjectId, activeMaster?.id]);

  const capturePlaybackSnapshot = useCallback(
    (
      targetMasterId: number,
      sourceSnapshot?: PlaybackSnapshot | null,
    ): PlaybackSnapshot => {
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
    async (loadError: unknown) => {
      const failedMaster = currentMasterRef.current;
      const failedSnapshot = lastLoadSnapshotRef.current;
      const sdrFallback = getSdrFallback(playableMasters, failedMaster);
      if (!mountedRef.current) return;

      setPlaybackState("error");
      manualSelectionRef.current = true;

      if (
        sdrFallback &&
        failedMaster &&
        sdrFallback.id !== failedMaster.id &&
        !fallbackAttemptedRef.current
      ) {
        fallbackAttemptedRef.current = true;
        const video = videoRef.current;
        const snapshot = failedSnapshot && video && video.readyState >= 1
          ? { ...failedSnapshot, time: playbackTime(video) }
          : failedSnapshot;
        pendingPlaybackRef.current = capturePlaybackSnapshot(sdrFallback.id, snapshot);
        setError(null);
        setPlaybackNotice(`${failedMaster.label} playback failed. Using ${sdrFallback.label}.`);
        setActiveMasterId(sdrFallback.id);
        return;
      }

      setError(playbackErrorMessage(loadError));
    },
    [capturePlaybackSnapshot, playableMasters],
  );

  useEffect(() => {
    playbackErrorHandlerRef.current = handleFatalPlaybackError;
  }, [handleFatalPlaybackError]);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;

    async function loadMaster() {
      const video = videoRef.current;
      if (!video || !activeMaster || !selectionReady) return;

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
      loadingMasterRef.current = true;
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

        if (playerRef.current && playerVideoRef.current !== video) {
          await playerRef.current.destroy();
          playerRef.current = null;
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
            if (playerRef.current !== player) return;
            const detail = "detail" in event ? event.detail : null;
            if (detail && typeof detail === "object" && "severity" in detail && detail.severity === 1) return;
            void playbackErrorHandlerRef.current(detail);
          });
          playerRef.current = player;
          playerVideoRef.current = video;
        }

        // Capability checks used native HLS when available; use that same path for HDR playback.
        playerRef.current.configure({ streaming: { preferNativeHls: isHdrVideo(activeMaster) && detectCapabilities().nativeHls } });
        await playerRef.current.load(source, snapshot.time > 0 ? snapshot.time : null);
        if (
          cancelled ||
          !mountedRef.current ||
          snapshot.requestId !== loadRequestIdRef.current
        ) {
          return;
        }
        loadingMasterRef.current = false;

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

        loadingMasterRef.current = false;
        await handleFatalPlaybackError(loadError);
      }
    }

    void loadMaster();
    return () => { cancelled = true; };
  }, [activeMaster, capturePlaybackSnapshot, handleFatalPlaybackError, reloadNonce, selectionReady]);

  useEffect(() => {
    return () => {
      void playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  const switchMaster = useCallback((master: VideoMaster) => {
    // A slow automatic probe must never override an explicit user choice.
    manualSelectionRef.current = true;
    setSelectionReady(true);
    if (master.id === activeMasterId) return;

    fallbackAttemptedRef.current = false;
    setPlaybackNotice(null);
    pendingPlaybackRef.current = capturePlaybackSnapshot(master.id);
    setActiveMasterId(master.id);
  }, [activeMasterId, capturePlaybackSnapshot]);

  const retry = useCallback(() => {
    if (activeMaster) {
      fallbackAttemptedRef.current = false;
      setPlaybackNotice(null);
      pendingPlaybackRef.current = capturePlaybackSnapshot(activeMaster.id);
      setReloadNonce((value) => value + 1);
    }
  }, [activeMaster, capturePlaybackSnapshot]);

  if (!activeMaster) {
    return (
      <div className="player-shell empty-state" role="status">
        <p>
          {playableMasters.length
            ? "No compatible master was confirmed. Select a version manually."
            : masters.length ? "No verified video masters are ready for playback."
              : "No video masters have been configured for this project."}
        </p>
        {playableMasters.map(master => <button key={master.id} type="button" onClick={() => switchMaster(master)}>{master.label}</button>)}
        {addMaster ? (
    <Link className="master-add" href={addMaster.href}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      {addMaster.label}
    </Link>
        ) : null}
      </div>
    );
  }

  const hdrWarning =
    capabilities && isHdrMaster(activeMaster) && !capabilities.hdr
      ? "This display may not support HDR playback. If playback fails, an available SDR master will be used."
      : null;

  const resolutionLabel = masterResolution(activeMaster);
  const sourceFormat = resolveSourceFormat(activeMaster);
  const dolbyProfileVersion = formatDolbyProfileVersion(
    activeMaster.dolby_profile,
    activeMaster.dolby_compatibility_id,
  );

  return (
    <section className="player-shell" aria-label="Video player">
      <div className="player-layout">
        <div className="player-main">
          <div className="player-frame" data-state={playbackState} data-vt="cover">
            {/* Hide common download UI only; these hints do not protect the media from capture. */}
            <video
              ref={videoRef}
              className="video-player"
              controls
              controlsList="nodownload"
              onContextMenu={(event) => event.preventDefault()}
              playsInline
              poster={poster || undefined}
              aria-label={`Video player - ${activeMaster.label}`}
              preload="metadata"
              onError={() => void handleFatalPlaybackError(
                new Error(videoRef.current?.error?.message || "Video decoding failed.")
              )}
            />
          </div>

          <div className="player-controls-row">
            <div className="master-bar" role="group" aria-label="Video master switcher">
              {playableMasters.map((master) => (
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
                    <small>播放：{playbackFormat(master)}</small>
                  </span>
                </button>
              ))}
              {addMaster ? (
    <Link className="master-add" href={addMaster.href}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      {addMaster.label}
    </Link>
              ) : null}
            </div>

            <div className="info-toggle-row">
              <button
                className={infoOpen ? "info-toggle active" : "info-toggle"}
                onClick={() => setInfoOpen((open) => !open)}
                type="button"
                aria-expanded={infoOpen}
                aria-controls="player-info-panel"
              >
                <span>{infoOpen ? "Hide Info" : "Show Info"}</span>
                <span className="info-toggle-state" aria-hidden="true">
                  {infoOpen ? "\u2212" : "+"}
                </span>
              </button>
            </div>
          </div>

          {/* Source identity never changes the codec/range used for capability checks. */}
          <div className={formatStyles.summary} aria-live="polite" aria-label="源母版与当前播放版本">
            <p><strong>源母版：</strong>{sourceFormatLabel(sourceFormat)}{sourceFormat?.dolbyVision.status === "declared" ? " · 含 Dolby Vision 元数据声明" : ""}</p>
            <p><strong>当前播放版本：</strong>{playbackFormat(activeMaster)} · {activeMaster.codec || "编码未记录"}</p>
            {sourceFormat?.container === "imf" ? <p>{dolbyPlaybackLabel(sourceFormat)}</p> : null}
          </div>

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

            <div className="info-panel-body">
              <VideoFormatInfo source={sourceFormat} playback={playbackFormat(activeMaster)} />
              <div className="info-section info-section-master">
                <h3>Playback Version</h3>
                <dl className="tech-grid" aria-label="Current master technical details">
                  <div><dt>Type</dt><dd>{playbackFormat(activeMaster)}</dd></div>
                  <div><dt>Codec</dt><dd>{activeMaster.codec || "N/A"}</dd></div>
                  <div><dt>Resolution</dt><dd>{resolutionLabel || "N/A"}</dd></div>
                  <div><dt>Gamut</dt><dd>{formatDisplayGamut(activeMaster)}</dd></div>
                  <div><dt>Color Space</dt><dd>{activeMaster.color_space || "N/A"}</dd></div>
                  <div><dt>Primaries</dt><dd>{activeMaster.color_primaries || "N/A"}</dd></div>
                  <div><dt>Transfer</dt><dd>{activeMaster.color_transfer || activeMaster.transfer_function || "N/A"}</dd></div>
                  <div><dt>Matrix</dt><dd>{activeMaster.matrix_coefficients || "N/A"}</dd></div>
                  <div><dt>Range</dt><dd>{activeMaster.color_range || "N/A"}</dd></div>
                  <div><dt>HLS Range</dt><dd>{activeMaster.hls_video_range || "N/A"}</dd></div>
                  <div><dt>Pixel Format</dt><dd>{activeMaster.pixel_format || "N/A"}</dd></div>
                  <div><dt>Chroma</dt><dd>{activeMaster.chroma_location || "N/A"}</dd></div>
                  <div>
                    <dt>Bit Depth</dt>
                    <dd>{activeMaster.bit_depth ? `${activeMaster.bit_depth}-bit` : "N/A"}</dd>
                  </div>
                  <div><dt>Processing</dt><dd>{activeMaster.processing_mode || "N/A"}</dd></div>
                  <div><dt>Verified</dt><dd>{activeMaster.verification_status || "N/A"}</dd></div>
                  <div><dt>Derivative</dt><dd>{formatPresent(activeMaster.is_derivative)}</dd></div>
                  {activeMaster.is_derivative ? (
                    <>
                      <div><dt>Source Master</dt><dd>{activeMaster.derived_from_master_id || "N/A"}</dd></div>
                      <div><dt>Intent</dt><dd>{activeMaster.conversion_intent || "N/A"}</dd></div>
                    </>
                  ) : null}
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
                <div className="info-section info-section-device">
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
            </div>
          </aside>

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
          {playbackNotice ? (
            <p className="player-warning" role="status">{playbackNotice}</p>
          ) : null}
        </div>

      </div>
    </section>
  );
}

function formatDisplayGamut(master: VideoMaster) {
  if (master.display_gamut === "bt2020") return "BT.2020";
  if (master.display_gamut === "p3_d65") return "P3-D65(smpte432)";
  if (master.display_gamut === "dci_p3") return "DCI-P3(smpte431)";
  if (master.display_gamut === "bt709") return "BT.709";
  return master.color_space || master.display_gamut || "N/A";
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
    hdr: Boolean(window.matchMedia?.("(video-dynamic-range: high)")?.matches ||
      window.matchMedia?.("(dynamic-range: high)")?.matches),
    p3: window.matchMedia?.("(color-gamut: p3)")?.matches ?? false,
    rec2020: window.matchMedia?.("(color-gamut: rec2020)")?.matches ?? false,
    hevc:
      video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== "" ||
      video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== "",
    nativeHls: video.canPlayType("application/vnd.apple.mpegurl") !== "",
  };
}
