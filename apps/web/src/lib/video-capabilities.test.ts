import { describe, expect, it, vi } from "vitest";
import type { VideoMaster } from "./directus";
import { hdrConfiguration, selectAutomaticMaster, type PlaybackEnvironment } from "./video-capabilities";

function master(id: number, type: VideoMaster["type"]): VideoMaster {
  return { id, type, label: type, hls_url: `/media/${id}/master.m3u8`, verification_status: "ready",
    is_default: type === "sdr", color_primaries: "bt2020", hls_video_range: type === "sdr" ? "SDR" : type === "hlg" ? "HLG" : "PQ" } as VideoMaster;
}
const sdr = master(1, "sdr");
const hdr = master(2, "hdr10");
const dv = master(3, "dolby_vision");
const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:CODECS="hvc1.2.4.L153.B0,mp4a.40.2",SUPPLEMENTAL-CODECS="dvh1.08.06/db1p",RESOLUTION=3840x2160,FRAME-RATE=24.000,BANDWIDTH=20000000,VIDEO-RANGE=PQ\nmedia.m3u8';
const environment = (patch: Partial<PlaybackEnvironment> = {}): PlaybackEnvironment => ({
  hdrDisplay: true, nativeHls: true, canPlayType: () => "probably", mseSupports: () => true,
  decodingInfo: async () => ({ supported: true, smooth: true }), manifest: async () => manifest, ...patch
});

describe("capability-based initial master selection", () => {
  it("prefers confirmed Dolby, then another supported HDR, over a database SDR default", async () => {
    const info = vi.fn(async () => ({ supported: true, smooth: true }));
    expect(await selectAutomaticMaster([sdr, hdr, dv], environment({ decodingInfo: info }), new AbortController().signal)).toBe(dv);
    expect(info.mock.calls[0]).toEqual([expect.objectContaining({ video: expect.objectContaining({
      contentType: 'video/mp4; codecs="dvh1.08.06"', transferFunction: "pq", colorGamut: "rec2020", width: 3840
    }) })]);
    const env = environment({ canPlayType: type => type.includes("dvh1") ? "" : "probably" });
    expect(await selectAutomaticMaster([sdr, hdr, dv], env, new AbortController().signal)).toBe(hdr);
  });
  it("uses SDR for SDR displays, unknown support, decode errors, or unsmooth decoding", async () => {
    for (const env of [environment({ hdrDisplay: false }), environment({ decodingInfo: undefined }),
      environment({ decodingInfo: async () => { throw new Error("unsupported"); } }),
      environment({ decodingInfo: async () => ({ supported: true, smooth: false }) }),
      environment({ manifest: async () => { throw new Error("offline"); } })]) {
      expect(await selectAutomaticMaster([hdr, sdr], env, new AbortController().signal)).toBe(sdr);
    }
  });
  it("never treats generic HEVC as Dolby and uses the same native/MSE path as playback", () => {
    expect(hdrConfiguration(dv, manifest.replace(/,SUPPLEMENTAL-CODECS="[^"]*"/, ""), environment())).toBeNull();
    expect(hdrConfiguration(hdr, manifest, environment({ nativeHls: false }))?.type).toBe("media-source");
    expect(hdrConfiguration(hdr, manifest, environment({ nativeHls: false, mseSupports: () => false }))).toBeNull();
    expect(hdrConfiguration(hdr, manifest.replace("FRAME-RATE=24.000,", ""), environment())).toBeNull();
  });
  it("automatically loads a verified custom SDR default when HDR support is unavailable", async () => {
    const custom = { ...master(4, "custom"), is_default: true, hls_video_range: "SDR" };
    // Custom labels do not change an explicitly verified SDR playback range.
    for (const env of [environment({ hdrDisplay: false }), environment({ decodingInfo: undefined }),
      environment({ decodingInfo: async () => ({ supported: false, smooth: false }) })]) {
      expect(await selectAutomaticMaster([hdr, { ...sdr, is_default: false }, custom], env, new AbortController().signal)).toBe(custom);
      expect(await selectAutomaticMaster([custom], env, new AbortController().signal)).toBe(custom);
    }
  });
  it("does not treat unknown, HDR, or unverified custom masters as SDR fallback", async () => {
    for (const custom of [master(4, "custom"), { ...master(4, "custom"), hls_video_range: null },
      { ...master(4, "custom"), hls_video_range: "SDR", verification_status: "quarantine" }]) {
      expect(await selectAutomaticMaster([custom], environment({ hdrDisplay: false }), new AbortController().signal)).toBeUndefined();
    }
  });
  it("rejects unverified masters and does not select unknown HDR when no SDR exists", async () => {
    expect(await selectAutomaticMaster([{ ...hdr, verification_status: "quarantine" }, sdr], environment(), new AbortController().signal)).toBe(sdr);
    expect(await selectAutomaticMaster([hdr], environment({ hdrDisplay: false }), new AbortController().signal)).toBeUndefined();
    const controller = new AbortController(); controller.abort();
    expect(await selectAutomaticMaster([hdr, sdr], environment(), controller.signal)).toBe(sdr);
  });
  it("times out a hung capability query instead of blocking fallback", async () => {
    vi.useFakeTimers();
    try {
      const selection = selectAutomaticMaster([hdr, sdr], environment({ decodingInfo: () => new Promise(() => {}) }), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1600);
      expect(await selection).toBe(sdr);
    } finally { vi.useRealTimers(); }
  });
  it("retains custom SDR fallback when capability detection times out or is cancelled", async () => {
    const custom = { ...master(4, "custom"), is_default: true, hls_video_range: "SDR" };
    const controller = new AbortController(); controller.abort();
    expect(await selectAutomaticMaster([hdr, custom], environment(), controller.signal)).toBe(custom);
    vi.useFakeTimers();
    try {
      const selection = selectAutomaticMaster([hdr, custom], environment({ decodingInfo: () => new Promise(() => {}) }), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1600);
      expect(await selection).toBe(custom);
    } finally { vi.useRealTimers(); }
  });
});
