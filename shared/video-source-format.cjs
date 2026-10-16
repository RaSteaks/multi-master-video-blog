// Public, bounded metadata only. Raw probes, paths, XML and encoder diagnostics
// must never be copied into the object serialized to the player.
function sanitizeSourceFormat(input) {
  if (!input || typeof input !== "object" || input.version !== 1) return null;
  const choose = (value, allowed, fallback = null) => allowed.includes(value) ? value : fallback;
  const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
  const dolby = input.dolbyVision || {};
  return {
    version: 1,
    container: choose(input.container, ["imf", "embedded", "unknown"], "unknown"),
    applicationIds: Array.isArray(input.applicationIds) ? [...new Set(input.applicationIds.filter(value => typeof value === "string" && /^https?:\/\//.test(value)).map(value => value.slice(0, 240)))].slice(0, 8) : [],
    colorModel: choose(input.colorModel, ["rgb", "ycbcr", "mixed", "unknown"], "unknown"),
    codec: choose(input.codec, ["jpeg2000", "h264", "hevc", "av1", "prores", "ffv1"]),
    bitDepth: choose(input.bitDepth, [8, 10, 12, 14, 16, 32]),
    primaries: choose(input.primaries, ["bt709", "bt2020", "smpte432", "smpte431", "smpte428", "smpte170m", "bt470bg"]),
    transfer: choose(input.transfer, ["bt709", "smpte2084", "arib-std-b67", "gamma22", "gamma28", "linear", "smpte240m", "smpte170m", "bt2020-10", "bt2020-12", "smpte428", "iec61966-2-1"]),
    range: choose(input.range, ["full", "limited", "custom", "unknown"], "unknown"),
    dynamicRange: choose(input.dynamicRange, ["pq", "hlg", "sdr", "unknown"], "unknown"),
    compositionCount: number(input.compositionCount), segmentCount: number(input.segmentCount),
    packageKind: choose(input.packageKind, ["self_contained", "external_references", "unknown"], "unknown"),
    missingResources: number(input.missingResources), preset: null,
    dolbyVision: {
      status: dolby.status === "verified_rpu" && dolby.validation !== "bitstream_verified" ? "declared"
        : choose(dolby.status, ["declared", "candidate", "unlinked", "verified_rpu", "unknown"], "unknown"),
      storage: Array.isArray(dolby.storage) ? [...new Set(dolby.storage.filter(value => ["isxd", "phdr", "xml", "rpu"].includes(value)))] : [],
      validation: dolby.status === "verified_rpu" && dolby.validation === "bitstream_verified" ? "bitstream_verified" : "not_validated",
      playbackUse: choose(dolby.playbackUse, ["embedded_in_output", "applied_to_conversion", "not_applied", "unknown"], "unknown")
    }
  };
}

function sourceFormatFromProbe(probe = {}) {
  if (!probe || typeof probe !== "object" || (!probe.codec_name && !probe.imf)) return null;
  if (probe.imf?.sourceFormat) {
    const declared = sanitizeSourceFormat(probe.imf.sourceFormat);
    const decoded = sourceFormatFromProbe({ ...probe, imf: null });
    if (!declared) return decoded;
    for (const field of ["codec", "bitDepth", "primaries", "transfer"]) if (declared[field] === null) declared[field] = decoded?.[field] ?? null;
    return declared;
  }
  const dolby = (Array.isArray(probe.side_data_list) ? probe.side_data_list : []).find(item => /dovi configuration/i.test(item.side_data_type || ""));
  const verifiedRpu = Boolean(dolby?.rpu_present_flag && probe.dovi_rpu_integrity?.count > 0 &&
    probe.dovi_rpu_integrity?.sha256 && probe.dovi_frame_metadata_present);
  const transfer = probe.color_transfer;
  return sanitizeSourceFormat({
    version: 1, container: probe.imf ? "imf" : "embedded",
    colorModel: /^(?:rgb|bgr|gbr)/.test(probe.pix_fmt || "") ? "rgb" : /^yuva?/.test(probe.pix_fmt || "") ? "ycbcr" : "unknown",
    codec: probe.codec_name, bitDepth: Number(probe.bits_per_raw_sample) ||
      Number(String(probe.pix_fmt || "").match(/(?:p|rgb|bgr)(10|12|16)(?:le|be)$/)?.[1]) ||
      (["yuv420p", "yuv422p", "yuv444p", "rgb24", "bgr24", "gbrp"].includes(probe.pix_fmt) ? 8 : null),
    primaries: probe.color_primaries, transfer,
    range: ["pc", "full"].includes(probe.color_range) ? "full" : ["tv", "limited"].includes(probe.color_range) ? "limited" : "unknown",
    dynamicRange: transfer === "smpte2084" ? "pq" : transfer === "arib-std-b67" ? "hlg"
      : ["bt709", "smpte170m", "gamma22", "gamma28", "iec61966-2-1", "bt2020-10", "bt2020-12"].includes(transfer) ? "sdr" : "unknown",
    // Legacy imf.hasDolbyMetadata records support a declaration, never full validation.
    dolbyVision: { status: verifiedRpu ? "verified_rpu" : probe.imf?.hasDolbyMetadata || dolby ? "declared" : "unknown",
      storage: dolby ? ["rpu"] : [], validation: verifiedRpu ? "bitstream_verified" : "not_validated" }
  });
}

function sourceFormatForPlayback(source, outputContract = {}, conversion) {
  const summary = sanitizeSourceFormat(source);
  if (!summary) return null;
  summary.dolbyVision.playbackUse = outputContract.dolbyMetadata?.rpuPresent && outputContract.dolbyMetadata?.profile
    ? "embedded_in_output" : conversion?.usesDolbyMetadata === true ? "applied_to_conversion"
      : conversion?.usesDolbyMetadata === false || summary.container === "imf" ? "not_applied" : "unknown";
  return summary;
}

module.exports = { sanitizeSourceFormat, sourceFormatFromProbe, sourceFormatForPlayback };
