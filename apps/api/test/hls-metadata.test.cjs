const test = require("node:test");
const assert = require("node:assert/strict");
const { videoCodecFromProbe, audioCodecFromProbe, codecStringFromProbe, hlsAttributesFromProbe } = require("../src/hls-metadata.cjs");

test("AVC uses configuration/SPS bytes, including constraint flags and the actual level", () => {
  assert.equal(videoCodecFromProbe({ codec_name: "h264", extradata: Buffer.from("0164001eff", "hex") }), "avc1.64001E");
  assert.equal(videoCodecFromProbe({ codec_name: "h264", extradata: "\n00000000: 0000 0167 42c0 1e80  ...gB...\n" }), "avc1.42C01E");
});

test("HEVC derives Main10, reversed compatibility flags, tier, level and constraints from hvcC or SPS", () => {
  const config = "2220000000b0000000000078";
  assert.equal(videoCodecFromProbe({ codec_name: "hevc", extradata: Buffer.from(`01${config}`, "hex") }), "hvc1.2.4.H120.B0");
  assert.equal(videoCodecFromProbe({ codec_name: "hevc", codec_tag_string: "hev1", extradata: Buffer.from(`00000001420101${config.replace("2220", "0220")}`, "hex") }), "hev1.2.4.L120.B0");
});

test("audio declarations reflect present streams and AAC object types; unknown codecs fail verification", () => {
  const video = { codec_name: "h264", extradata: Buffer.from("01640028", "hex") };
  assert.equal(codecStringFromProbe(video), "avc1.640028");
  assert.equal(codecStringFromProbe({ ...video, audio_streams: [{ codec_name: "aac", profile: "LC" }] }), "avc1.640028,mp4a.40.2");
  assert.equal(audioCodecFromProbe({ codec_name: "aac", extradata: Buffer.from("2b92", "hex") }), "mp4a.40.5");
  assert.equal(audioCodecFromProbe({ codec_name: "aac", profile: "HE-AACv2" }), "mp4a.40.29");
  assert.equal(audioCodecFromProbe({ codec_name: "aac", profile: "HE-AAC", extradata: Buffer.from("1190", "hex") }), "mp4a.40.5");
  assert.throws(() => audioCodecFromProbe({ codec_name: "aac" }), { statusCode: 422 });
  assert.throws(() => codecStringFromProbe({ ...video, audio_streams: [{ codec_name: "pcm_s16le" }] }), /Unsupported audio codec/);
  assert.throws(() => videoCodecFromProbe({ codec_name: "hevc", profile: "Main 10", level: 120 }), /configuration\/SPS is missing/);
});

test("AV1 does not assume ten-bit Main profile or a fixed level", () => {
  assert.equal(videoCodecFromProbe({ codec_name: "av1", extradata: Buffer.from("81080000", "hex") }), "av01.0.08M.08");
  assert.equal(videoCodecFromProbe({ codec_name: "av1", extradata: Buffer.from("812dc000", "hex") }), "av01.1.13H.10");
});

test("embedded P8.4 advertises its HLG base and Dolby supplemental codec; SDR never inherits that declaration", () => {
  const video = {
    codec_name: "hevc", codec_tag_string: "hvc1", width: 1920, height: 1080,
    avg_frame_rate: "24000/1001", color_transfer: "arib-std-b67",
    extradata: Buffer.from("010220000000b0000000000078", "hex"),
    side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8, dv_level: 3, rpu_present_flag: 1, dv_bl_signal_compatibility_id: 4 }]
  };
  const attributes = hlsAttributesFromProbe(video);
  assert.equal(attributes.CODECS, "hvc1.2.4.L120.B0");
  assert.equal(attributes["SUPPLEMENTAL-CODECS"], "dvh1.08.03/db4h");
  assert.equal(attributes["VIDEO-RANGE"], "HLG");
  assert.equal(attributes["FRAME-RATE"], "23.976");
  const p5 = { ...video, side_data_list: [{ ...video.side_data_list[0], dv_profile: 5 }] };
  assert.throws(() => videoCodecFromProbe(p5), /requires a dvh1\/dvhe/);
  assert.equal(videoCodecFromProbe({ ...p5, codec_tag_string: "dvh1" }), "dvh1.05.03");
  const sdr = hlsAttributesFromProbe({ ...video, codec_name: "h264", extradata: Buffer.from("01640028", "hex"), side_data_list: [], color_transfer: "bt709" }, { hlsVideoRange: "HLG" });
  assert.equal(sdr["VIDEO-RANGE"], "SDR");
  assert.equal(sdr["SUPPLEMENTAL-CODECS"], undefined);
});
