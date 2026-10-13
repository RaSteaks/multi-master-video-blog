import { describe, expect, it } from "vitest";
import { getDefaultMaster, getSdrFallback, isPlayableMaster, playbackErrorMessage } from "./video-playback";

function master(id: number, type: "sdr" | "dolby_vision", overrides = {}) {
  return {
    id, type, is_default: false, verification_status: "ready", hls_url: `/media/${id}/master.m3u8`,
    derived_from_master_id: null, ...overrides,
  };
}

describe("video master selection and automatic SDR fallback", () => {
  it("retains Shaka diagnostics even though Shaka errors are not native Error instances", () => {
    const error = { message: "Shaka Error 3015", code: 3015, severity: 2 };
    expect(error instanceof Error).toBe(false);
    expect(playbackErrorMessage(error)).toBe("Shaka Error 3015");
    expect(playbackErrorMessage({ code: 4025 })).toContain("4025");
  });
  it("defaults to verified SDR when no explicit default exists", () => {
    expect(getDefaultMaster([master(1, "dolby_vision"), master(2, "sdr")])?.id).toBe(2);
    expect(getDefaultMaster([master(1, "dolby_vision", { is_default: true }), master(2, "sdr")])?.id).toBe(1);
  });

  it("prefers the SDR derived from the failed Dolby master", () => {
    const dv = master(1, "dolby_vision");
    expect(getSdrFallback([
      master(2, "sdr", { is_default: true }), master(3, "sdr", { derived_from_master_id: 1 }), dv,
    ], dv)?.id).toBe(3);
  });

  it("uses another verified SDR if the paired derivative is unavailable", () => {
    const dv = master(1, "dolby_vision");
    expect(getSdrFallback([
      dv, master(2, "sdr", { derived_from_master_id: 1, verification_status: "rejected" }),
      master(3, "sdr", { is_default: true }),
    ], dv)?.id).toBe(3);
  });

  it("cannot loop back to HDR or use an empty/unverified SDR source", () => {
    const dv = master(1, "dolby_vision");
    const sdr = master(2, "sdr");
    expect(getSdrFallback([dv, sdr], sdr)).toBeUndefined();
    expect(getSdrFallback([dv], dv)).toBeUndefined();
    expect(getSdrFallback([dv, master(2, "sdr", { hls_url: "" })], dv)).toBeUndefined();
    expect(isPlayableMaster(master(2, "sdr", { verification_status: "quarantine" }))).toBe(false);
  });
});
