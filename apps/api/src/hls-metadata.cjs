function metadataError(message) {
  return Object.assign(new Error(`HLS verification failed: ${message}`), { statusCode: 422 });
}

function probeExtraData(stream) {
  if (Buffer.isBuffer(stream.extradata)) return stream.extradata;
  const text = String(stream.extradata || "");
  // ffprobe -show_data prints a hex column followed by an ASCII column.
  const hex = text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*[\da-f]+:\s+((?:[\da-f]{2,4}(?: |$))+)/i);
    return match ? [match[1].replace(/\s/g, "")] : [];
  }).join("");
  return Buffer.from(hex, "hex");
}

function annexBParameterSet(data, codec) {
  const starts = [...data.toString("hex").matchAll(/00000001|000001/g)]
    .filter(match => match.index % 2 === 0)
    .map(match => ({ start: match.index / 2, offset: (match.index + match[0].length) / 2 }));
  for (let index = 0; index < starts.length; index += 1) {
    const { offset } = starts[index];
    const nal = data.subarray(offset, starts[index + 1]?.start ?? data.length);
    if (codec === "h264" && (nal[0] & 0x1f) === 7) return nal.subarray(1);
    if (codec === "hevc" && ((nal[0] >> 1) & 0x3f) === 33) {
      const rbsp = [];
      for (let byte = 2; byte < nal.length; byte += 1) {
        if (nal[byte] === 3 && nal[byte - 1] === 0 && nal[byte - 2] === 0) continue;
        rbsp.push(nal[byte]);
      }
      // The SPS header precedes general_profile_tier_level by one byte.
      return Buffer.from(rbsp).subarray(1);
    }
  }
  return Buffer.alloc(0);
}

function dolbyConfiguration(probe) {
  return (probe.side_data_list || []).find(item => /dovi configuration/i.test(item.side_data_type || ""));
}

function videoCodecFromProbe(probe) {
  const codec = String(probe.codec_name || "").toLowerCase();
  const data = probeExtraData(probe);
  if (codec === "h264") {
    const config = data[0] === 1 ? data.subarray(1, 4) : annexBParameterSet(data, "h264").subarray(0, 3);
    if (config.length !== 3) throw metadataError("AVC configuration/SPS is missing; cannot determine its profile and level.");
    return `${probe.codec_tag_string === "avc3" ? "avc3" : "avc1"}.${config.toString("hex").toUpperCase()}`;
  }
  if (codec === "hevc" || codec === "h265") {
    const dovi = dolbyConfiguration(probe);
    if (["dvh1", "dvhe"].includes(probe.codec_tag_string)) {
      if (!dovi?.dv_profile || !dovi?.dv_level || !dovi.rpu_present_flag) {
        throw metadataError("Dolby Vision sample entry has no usable embedded configuration.");
      }
      return `${probe.codec_tag_string}.${String(dovi.dv_profile).padStart(2, "0")}.${String(dovi.dv_level).padStart(2, "0")}`;
    }
    if (Number(dovi?.dv_profile) === 5 && dovi.rpu_present_flag) {
      throw metadataError("Dolby Vision Profile 5 requires a dvh1/dvhe sample entry.");
    }
    const config = data[0] === 1 ? data.subarray(1, 13) : annexBParameterSet(data, "hevc").subarray(0, 12);
    if (config.length !== 12) throw metadataError("HEVC configuration/SPS is missing; cannot determine its profile, tier and level.");
    const profileSpace = ["", "A", "B", "C"][config[0] >> 6];
    const profile = config[0] & 0x1f;
    const tier = config[0] & 0x20 ? "H" : "L";
    let flags = config.readUInt32BE(1);
    let compatibility = 0;
    for (let bit = 0; bit < 32; bit += 1) {
      compatibility = (compatibility << 1) | (flags & 1);
      flags >>>= 1;
    }
    const constraints = [...config.subarray(5, 11)];
    while (constraints.at(-1) === 0) constraints.pop();
    const suffix = constraints.map(value => `.${value.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    const tag = probe.codec_tag_string === "hev1" ? "hev1" : "hvc1";
    return `${tag}.${profileSpace}${profile}.${(compatibility >>> 0).toString(16).toUpperCase()}.${tier}${config[11]}${suffix}`;
  }
  if (codec === "av1" && data.length >= 4 && data[0] === 0x81) {
    const profile = data[1] >> 5;
    const level = data[1] & 0x1f;
    const tier = data[2] & 0x80 ? "H" : "M";
    const depth = data[2] & 0x40 ? (data[2] & 0x20 ? 12 : 10) : 8;
    return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`;
  }
  throw metadataError(`Unsupported or incomplete video configuration: ${codec || "unknown"}.`);
}

function audioCodecFromProbe(stream) {
  const codec = String(stream.codec_name || "").toLowerCase();
  if (codec === "aac") {
    const data = probeExtraData(stream);
    let objectType = data.length ? data[0] >> 3 : 0;
    if (objectType === 31) objectType = data.length >= 2 ? 32 + ((data[0] & 7) << 3) + (data[1] >> 5) : 0;
    const profileType = { LC: 2, "HE-AAC": 5, "HE-AACv2": 29 }[stream.profile];
    // Implicit SBR/PS can extend a type-2 ASC; ffprobe reports the decoded profile.
    if (!objectType || (objectType === 2 && profileType > 2)) objectType = profileType;
    if (!objectType) throw metadataError("AAC AudioSpecificConfig and a recognized profile are missing.");
    return `mp4a.40.${objectType}`;
  }
  const name = { ac3: "ac-3", eac3: "ec-3", opus: "opus", flac: "fLaC", mp3: "mp4a.40.34" }[codec];
  if (!name) throw metadataError(`Unsupported audio codec: ${codec || "unknown"}.`);
  return name;
}

function codecStringFromProbe(probe, additionalAudio = []) {
  return [...new Set([
    videoCodecFromProbe(probe),
    ...(probe.audio_streams || []).map(audioCodecFromProbe),
    ...additionalAudio.map(audioCodecFromProbe)
  ])].join(",");
}

function hlsAttributesFromProbe(probe, contract = {}, additionalAudio = []) {
  const attributes = { CODECS: codecStringFromProbe(probe, additionalAudio) };
  if (!(probe.width > 0 && probe.height > 0)) throw metadataError("Video dimensions are missing.");
  attributes.RESOLUTION = `${probe.width}x${probe.height}`;
  const [numerator, denominator = 1] = String(probe.avg_frame_rate || probe.r_frame_rate || "").split("/").map(Number);
  const frameRate = numerator / denominator;
  if (Number.isFinite(frameRate) && frameRate > 0) attributes["FRAME-RATE"] = frameRate.toFixed(3);
  const ranges = { "arib-std-b67": "HLG", smpte2084: "PQ", bt709: "SDR", bt470m: "SDR", bt470bg: "SDR", smpte170m: "SDR", smpte240m: "SDR", "iec61966-2-1": "SDR" };
  const videoRange = ranges[probe.color_transfer] || contract.hlsVideoRange;
  if (videoRange) attributes["VIDEO-RANGE"] = videoRange;
  const dovi = dolbyConfiguration(probe);
  if (Number(dovi?.dv_profile) === 8 && dovi.rpu_present_flag && dovi.dv_level > 0) {
    const brand = { 1: "db1p", 4: "db4h" }[dovi.dv_bl_signal_compatibility_id];
    if (brand) {
      const expectedRange = Number(dovi.dv_bl_signal_compatibility_id) === 4 ? "HLG" : "PQ";
      if (videoRange !== expectedRange) throw metadataError(`Dolby Vision base-layer compatibility requires VIDEO-RANGE=${expectedRange}.`);
      const tag = probe.codec_tag_string === "hev1" ? "dvhe" : "dvh1";
      attributes["SUPPLEMENTAL-CODECS"] = `${tag}.08.${String(dovi.dv_level).padStart(2, "0")}/${brand}`;
    }
  }
  return attributes;
}

module.exports = {
  probeExtraData, videoCodecFromProbe, audioCodecFromProbe,
  codecStringFromProbe, hlsAttributesFromProbe
};
