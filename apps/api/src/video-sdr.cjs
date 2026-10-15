const AUTO_SDR_CONVERSION = "dolby_vision_to_sdr";

function buildDolbySdrConversion(contract, filters) {
  const dolby = contract.dolbyMetadata || {};
  if (dolby.profile && (!dolby.rpuPresent || dolby.elPresent)) {
    throw new Error("SDR conversion requires embedded RPU and a single-layer Dolby Vision source.");
  }
  if (!dolby.profile && !["arib-std-b67", "smpte2084"].includes(contract.colorTransfer)) {
    throw new Error("Automatic HDR conversion requires a tagged PQ/HLG or verified Dolby Vision source.");
  }
  if (!filters.has("libplacebo")) {
    throw new Error("Adaptive HDR to SDR conversion requires FFmpeg with libplacebo and working Vulkan. The original HDR master has been retained.");
  }
  return {
    engine: "libplacebo",
    usesDolbyMetadata: Boolean(dolby.profile && dolby.rpuPresent),
    inputOptions: ["-init_hw_device", "vulkan"],
    // Dynamic peak analysis is smoothed across frames and reset at scene cuts.
    // Perceptual gamut mapping compresses wide-gamut colors instead of RGB clipping.
    filter: "libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p:apply_dolbyvision=true:peak_detect=true:smoothing_period=20:scene_threshold_low=1:scene_threshold_high=3:tonemapping=bt.2390:gamut_mode=perceptual,format=yuv420p,sidedata=mode=delete"
  };
}

function buildSdrTranscodeFilter(contract) {
  if (!["bt709", "smpte170m", "bt470bg", "bt470m", "iec61966-2-1"].includes(contract.colorTransfer) ||
      contract.dolbyMetadata?.profile || contract.hdrStaticMetadata?.masteringDisplayPresent) {
    throw new Error("SDR transcode requires tagged SDR input. Upload HDR as its HDR master type to create an adaptive SDR derivative.");
  }
  if (["bt2020", "smpte431", "smpte432"].includes(contract.colorPrimaries)) {
    // Wide-gamut SDR also needs gamut compression; matrix conversion alone clips saturated colors.
    return "libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p:apply_dolbyvision=false:peak_detect=false:tonemapping=clip:gamut_mode=perceptual,format=yuv420p,sidedata=mode=delete";
  }
  // Decode range/matrix/transfer explicitly before converting primaries in floating point.
  return [
    `zscale=primariesin=${contract.colorPrimaries}:transferin=${contract.colorTransfer}:matrixin=${contract.matrixCoefficients}:rangein=${contract.colorRange}:transfer=linear`,
    "format=gbrpf32le", "zscale=primaries=bt709",
    "zscale=transfer=bt709:matrix=bt709:range=limited:dither=error_diffusion",
    "format=yuv420p", "sidedata=mode=delete"
  ].join(",");
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

function validateSdrDerivative(contract, sourceContract, sourceProbe = {}) {
  const expected = {
    codecName: "h264", colorPrimaries: "bt709", colorTransfer: "bt709",
    matrixCoefficients: "bt709", colorRange: "limited",
    pixelFormat: "yuv420p", bitDepth: 8, hlsVideoRange: "SDR"
  };
  const errors = Object.entries(expected).flatMap(([field, value]) =>
    contract[field] === value ? [] : [`SDR derivative: ${field} must be ${value}.`]
  );
  // FFmpeg bakes display rotation into the pixels; compare the resulting display dimensions.
  const rotation = Number(sourceProbe.side_data_list?.find(item =>
    /display matrix/i.test(item.side_data_type || ""))?.rotation ?? sourceProbe.tags?.rotate ?? 0);
  const dimensions = Math.abs(rotation % 180) === 90
    ? { width: sourceContract.height, height: sourceContract.width } : sourceContract;
  for (const field of ["width", "height"]) {
    if (contract[field] !== dimensions[field]) {
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
  AUTO_SDR_CONVERSION, buildDolbySdrConversion, buildSdrEncodeArgs, buildSdrTranscodeFilter,
  validateSdrDerivative
};
