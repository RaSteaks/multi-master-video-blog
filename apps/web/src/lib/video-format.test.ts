import { describe, it, expect, vi, afterEach } from "vitest";
import { applicationLabel, dolbyPlaybackLabel, dolbySourceLabel, playbackFormat, resolveSourceFormat, sourceFormatLabel } from "./video-format";
import { sanitizeSourceFormat, sourceFormatFromProbe, sourceFormatForPlayback } from "../../../../shared/video-source-format.cjs";
import { getVideoProject, type VideoMaster } from "./directus";

const source = sanitizeSourceFormat({ version: 1, container: "imf", colorModel: "rgb", bitDepth: 12,
  primaries: "smpte432", transfer: "smpte2084", dynamicRange: "pq", range: "full",
  applicationIds: ["http://www.smpte-ra.org/ns/2067-21/2021"],
  dolbyVision: { status: "declared", storage: ["isxd"], validation: "not_validated", playbackUse: "not_applied" } })!;
const master = (id: number, type: VideoMaster["type"], extras: Partial<VideoMaster> = {}) => ({ id, type, hls_video_range: type === "sdr" ? "SDR" : "PQ", ...extras } as VideoMaster);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("source vs playback display", () => {
  it("does not upgrade HDR10/SDR playback because an IMF declares Dolby metadata", () => {
    expect(sourceFormatLabel(source)).toBe("IMF · RGB / PQ · 12-bit");
    expect(playbackFormat(master(1,"hdr10",{source_format:source}))).toBe("HDR10");
    expect(playbackFormat(master(2,"sdr",{source_format:source}))).toBe("SDR");
    expect(dolbySourceLabel(source)).toContain("内容未验证");
    expect(dolbyPlaybackLabel(source)).toContain("未应用");
    expect(dolbySourceLabel(source,"en")).toContain("not validated");
    expect(applicationLabel(source.applicationIds[0])).toBe("Application 2E (2021)");
  });
  it("does not borrow a replaced parent's identity or guess legacy metadata use", () => {
    const sdr=master(2,"sdr",{derived_from_master_id:1});
    expect(resolveSourceFormat(sdr)).toBeNull();
    expect(resolveSourceFormat(master(3,"hdr10"))).toBeNull();
    expect(sourceFormatLabel(null)).toContain("未记录");
  });
  it("bounds public metadata and strips raw probes, paths, unsupported values and preset claims", () => {
    const cleaned=sanitizeSourceFormat({...source,preset:"Netflix certified",path:"/private/master.mxf",rawProbe:{secret:"private"},dolbyVision:{...source.dolbyVision,storage:["isxd","file:///private"],status:"verified_rpu",validation:"not_validated"}});
    expect(JSON.stringify(cleaned)).not.toMatch(/private|Netflix|rawProbe/);
    expect(cleaned?.dolbyVision.status).toBe("declared");
    expect(cleaned?.preset).toBeNull();
    expect(sourceFormatFromProbe({})).toBeNull();
  });
  it("distinguishes retained RPU from Dolby-assisted SDR generation", () => {
    expect(sourceFormatForPlayback(source,{dolbyMetadata:{profile:"8.1",rpuPresent:true}})?.dolbyVision.playbackUse).toBe("embedded_in_output");
    expect(sourceFormatForPlayback(source,{}, {usesDolbyMetadata:true})?.dolbyVision.playbackUse).toBe("applied_to_conversion");
    expect(sourceFormatForPlayback(source,{}, {usesDolbyMetadata:false})?.dolbyVision.playbackUse).toBe("not_applied");
  });
  it("does not serialize private CMS fields into player props", async () => {
    vi.stubEnv("DIRECTUS_STATIC_TOKEN", "fixture");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if(String(url).includes("/auth/login")) return new Response(JSON.stringify({data:{access_token:"fixture",expires:3600000}}));
      return new Response(JSON.stringify({data:[{id:1,slug:"fixture",published:true,masters:[{...master(1,"hdr10"), source_format:{...source,localPath:"/private"},source_probe_json:{filename:"/private/video.mxf"},notes:"private"}]}]}));
    }));
    const result=await getVideoProject("fixture");
    expect(result?.masters?.[0].source_format?.dolbyVision.storage).toEqual(["isxd"]);
    expect(JSON.stringify(result)).not.toMatch(/private|source_probe_json|notes/);
  });
});
