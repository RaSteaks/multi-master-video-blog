import type { VideoMaster } from "./directus";
import { getDefaultMaster, isPlayableMaster, isSdrMaster } from "./video-playback";

export type PlaybackEnvironment = {
  hdrDisplay: boolean;
  nativeHls: boolean;
  canPlayType: (type: string) => string;
  mseSupports: (type: string) => boolean;
  decodingInfo?: (config: MediaDecodingConfiguration) => Promise<{ supported: boolean; smooth: boolean }>;
  manifest: (master: VideoMaster, signal: AbortSignal) => Promise<string>;
};

export function isHdrVideo(master: VideoMaster) {
  return ["hdr10", "hlg", "dolby_vision"].includes(master.type) ||
    ["PQ", "HLG"].includes(master.hls_video_range || "");
}

export function hdrConfiguration(master: VideoMaster, manifest: string, env: PlaybackEnvironment): MediaDecodingConfiguration | null {
  const line = manifest.split(/\r?\n/).find(value => value.startsWith("#EXT-X-STREAM-INF:"));
  if (!line) return null;
  const attributes = Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,\s]+)/g)]
    .map(match => [match[1], match[2].replace(/^"|"$/g, "")]));
  const dolby = master.type === "dolby_vision";
  const codec = (dolby ? attributes["SUPPLEMENTAL-CODECS"] || attributes.CODECS : attributes.CODECS)
    ?.split(",").find(value => /^(?:avc[13]|hvc1|hev1|dvh1|dvhe|av01)\./.test(value))?.split("/")[0];
  // A generic HEVC result cannot establish Dolby Vision decoding support.
  if (!codec || (dolby && !/^dv(?:h1|he)\./.test(codec))) return null;
  const contentType = `video/mp4; codecs="${codec}"`;
  const type = env.nativeHls ? "file" : "media-source";
  if (type === "file" ? !env.canPlayType(contentType) : !env.mseSupports(contentType)) return null;
  const [width, height] = (attributes.RESOLUTION || "").split("x").map(Number);
  const framerate = Number(attributes["FRAME-RATE"]);
  const bitrate = Number(attributes.BANDWIDTH);
  if (![width, height, framerate, bitrate].every(value => Number.isFinite(value) && value > 0)) return null;
  const range = attributes["VIDEO-RANGE"];
  if (!["PQ", "HLG"].includes(range) || range !== master.hls_video_range) return null;
  const primaries = master.color_primaries;
  if (!["bt2020", "smpte432"].includes(primaries || "")) return null;
  return { type, video: { contentType, width, height, framerate, bitrate,
    colorGamut: primaries === "smpte432" ? "p3" : "rec2020",
    transferFunction: range === "HLG" ? "hlg" : "pq",
    ...(master.type === "hdr10" ? { hdrMetadataType: "smpteSt2086" as const } : {})
  } };
}

export async function selectAutomaticMaster(masters: VideoMaster[], env: PlaybackEnvironment, signal: AbortSignal) {
  const playable = masters.filter(isPlayableMaster);
  // Share SDR eligibility with playback recovery and the player's detection deadline.
  const sdr = getDefaultMaster(playable.filter(isSdrMaster));
  if (!env.hdrDisplay || !env.decodingInfo || signal.aborted) return sdr;
  const ranks: Partial<Record<VideoMaster["type"], number>> = { dolby_vision: 3, hdr10: 2, hlg: 1 };
  const priority = (master: VideoMaster) => (master.is_default ? 10 : 0) + (ranks[master.type] || 0);
  const candidates = playable.filter(isHdrVideo).sort((a, b) => priority(b) - priority(a));
  for (const master of candidates) {
    try {
      if (signal.aborted) return sdr;
      const config = hdrConfiguration(master, await env.manifest(master, signal), env);
      if (!config) continue;
      // Some platforms never settle a capability request; do not leave playback pending forever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const info = await Promise.race([
        env.decodingInfo(config),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); })
      ]).finally(() => clearTimeout(timer));
      if (!signal.aborted && info?.supported && info.smooth) return master;
    } catch { /* Unknown capability or unavailable manifest conservatively falls back to SDR. */ }
  }
  return sdr;
}
