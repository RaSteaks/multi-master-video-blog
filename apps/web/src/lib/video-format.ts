import type { VideoMaster } from "./directus";
import { sanitizeSourceFormat, type SourceFormat } from "../../../../shared/video-source-format.cjs";

export type { SourceFormat };
type Lang = "zh" | "en";

export function playbackFormat(master: Pick<VideoMaster, "type" | "hls_video_range">) {
  return { sdr: "SDR", hdr10: "HDR10", hlg: "HLG", dolby_vision: "Dolby Vision", custom: master.hls_video_range === "PQ" ? "PQ HDR" : master.hls_video_range || "Custom" }[master.type] || "Unknown";
}

export function sourceFormatLabel(input: unknown, lang: Lang = "zh") {
  const source = sanitizeSourceFormat(input);
  if (!source) return lang === "zh" ? "源格式未记录" : "Source format not recorded";
  const model = { rgb: "RGB", ycbcr: "Y′CbCr", mixed: lang === "zh" ? "混合格式" : "Mixed", unknown: "" }[source.colorModel];
  const range = { pq: "PQ", hlg: "HLG", sdr: "SDR", unknown: "" }[source.dynamicRange];
  const container = source.container === "imf" ? "IMF" : source.container === "embedded" ? (lang === "zh" ? "视频文件" : "Video file") : "";
  return [container, [model, range].filter(Boolean).join(" / "), source.bitDepth ? `${source.bitDepth}-bit` : ""].filter(Boolean).join(" · ");
}

export function applicationLabel(uri: string) {
  // Identify the declared SMPTE application family without asserting Netflix,
  // Disney or another vendor's delivery-preset compliance.
  const match = uri.match(/^https?:\/\/(?:www\.)?smpte-ra\.org\/(?:ns|schemas)\/2067-(\d+)(?:\/(\d{4}))?(?:\/|$)/i);
  if (!match) return uri;
  const names: Record<string, string> = { "20": "Application 2", "21": "Application 2E", "40": "Application 4", "50": "Application 5 (ACES)" };
  return `${names[match[1]] || `SMPTE ST 2067-${match[1]}`}${match[2] ? ` (${match[2]})` : ""}`;
}

export function dolbySourceLabel(input: unknown, lang: Lang = "zh") {
  const source = sanitizeSourceFormat(input);
  if (!source) return lang === "zh" ? "未知" : "Unknown";
  const d = source.dolbyVision;
  const location = d.storage.map(item => ({ isxd: "ISXD MXF", phdr: "PHDR / MXF", xml: "XML", rpu: "RPU" })[item]).join(" + ");
  const labels = lang === "zh"
    ? { declared: "检测到 Dolby Vision 元数据声明，内容未验证", candidate: "检测到 PHDR 结构，Dolby 内容未确认", unlinked: "检测到 Dolby XML，关联未验证", verified_rpu: "嵌入 RPU 已通过码流检查", unknown: "未确认是否含 Dolby Vision 元数据" }
    : { declared: "Dolby Vision metadata declared; contents not validated", candidate: "PHDR structure detected; Dolby contents unconfirmed", unlinked: "Dolby XML detected; association not validated", verified_rpu: "Embedded RPU passed bitstream checks", unknown: "Dolby Vision metadata presence is unconfirmed" };
  return `${labels[d.status]}${location ? ` (${location})` : ""}`;
}

export function dolbyPlaybackLabel(input: unknown, lang: Lang = "zh") {
  const use = sanitizeSourceFormat(input)?.dolbyVision.playbackUse || "unknown";
  return (lang === "zh" ? {
    embedded_in_output: "Dolby Vision RPU 保留在播放码流中；设备是否启用 Dolby Vision 取决于解码支持。",
    applied_to_conversion: "Dolby 动态元数据已用于生成此兼容版本；输出格式以上方播放版本为准。",
    not_applied: "此播放版本未应用 Dolby 动态元数据。",
    unknown: "未记录此播放版本是否使用 Dolby 动态元数据。"
  } : {
    embedded_in_output: "Dolby Vision RPU is retained in the playback stream; device activation depends on decoder support.",
    applied_to_conversion: "Dolby metadata was applied when generating this compatibility version; its output format is shown above.",
    not_applied: "This playback version does not apply the original Dolby dynamic metadata.",
    unknown: "Dolby metadata use was not recorded for this playback version."
  })[use];
}

export function resolveSourceFormat(master: VideoMaster) {
  // Parent IDs can survive an overwrite. The public player has no source hash
  // evidence and must not borrow the current parent's provenance for an old SDR.
  return sanitizeSourceFormat(master.source_format);
}
