const AUTO_SDR_CONVERSION = "dolby_vision_to_sdr";

function buildDolbySdrConversion(contract, filters) {
  const profile = Number.parseInt(contract.dolbyMetadata?.profile, 10);
  const transfer = contract.colorTransfer;
  const compatibleBase = profile !== 5 &&
    ["arib-std-b67", "smpte2084"].includes(transfer);

  if (!compatibleBase) {
    if (!filters.has("libplacebo") || !contract.dolbyMetadata?.rpuPresent) {
      throw new Error("This Dolby Vision source requires embedded RPU metadata and an FFmpeg build with libplacebo/Vulkan for SDR conversion. The original Dolby Vision master has been retained.");
    }
    return {
      engine: "libplacebo",
      usesDolbyMetadata: true,
      inputOptions: ["-init_hw_device", "vulkan"],
      filter: "libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p:apply_dolbyvision=true,format=yuv420p,sidedata=mode=delete"
    };
  }

  if (!filters.has("zscale") || !filters.has("tonemap")) {
    throw new Error("Automatic SDR conversion requires FFmpeg with zscale and tonemap filters. The original Dolby Vision master has been retained.");
  }

  const maxCll = Number(contract.hdrStaticMetadata?.contentLightLevel?.max_content);
  const peak = transfer === "smpte2084" && maxCll > 100 && maxCll <= 10000
    ? maxCll / 100 : 10;
  return {
    engine: "zscale-tonemap",
    usesDolbyMetadata: false,
    inputOptions: [],
    filter: [
      `zscale=primariesin=${contract.colorPrimaries}:transferin=${transfer}:matrixin=${contract.matrixCoefficients}:rangein=${contract.colorRange}:transfer=linear:npl=100`,
      "format=gbrpf32le",
      "zscale=primaries=bt709",
      `tonemap=tonemap=hable:desat=2:peak=${peak}`,
      "zscale=transfer=bt709:matrix=bt709:range=limited:dither=error_diffusion",
      "format=yuv420p",
      "sidedata=mode=delete"
    ].join(",")
  };
}

function buildSdrEncodeArgs(sourcePath, outputPath, conversion) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...conversion.inputOptions,
    "-i", sourcePath, "-map", "0:v:0", "-map", "0:a?",
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", conversion.filter,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-pix_fmt", "yuv420p", "-color_primaries", "bt709",
    "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-chroma_sample_location", "left",
    "-force_key_frames", "expr:gte(t,n_forced*4)", "-sc_threshold", "0",
    "-fps_mode", "passthrough", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", outputPath
  ];
}

function validateSdrDerivative(contract, sourceContract) {
  const expected = {
    codecName: "h264", colorPrimaries: "bt709", colorTransfer: "bt709",
    matrixCoefficients: "bt709", colorRange: "limited",
    pixelFormat: "yuv420p", bitDepth: 8, hlsVideoRange: "SDR"
  };
  const errors = Object.entries(expected).flatMap(([field, value]) =>
    contract[field] === value ? [] : [`SDR derivative: ${field} must be ${value}.`]
  );
  for (const field of ["width", "height"]) {
    if (contract[field] !== sourceContract[field]) {
      errors.push(`SDR derivative: ${field} changed during conversion.`);
    }
  }
  if (contract.dolbyMetadata?.profile || contract.dolbyMetadata?.rpuPresent ||
      contract.hdrStaticMetadata?.masteringDisplayPresent ||
      contract.hdrStaticMetadata?.contentLightLevelPresent) {
    errors.push("SDR derivative: HDR/Dolby Vision metadata must be removed.");
  }
  return errors;
}

module.exports = {
  AUTO_SDR_CONVERSION, buildDolbySdrConversion, buildSdrEncodeArgs,
  validateSdrDerivative
};
