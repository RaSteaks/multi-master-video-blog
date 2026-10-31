const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDolbySdrConversion, buildSdrEncodeArgs, validateSdrDerivative
} = require("../src/video-sdr.cjs");

const hdr = {
  codecName: "hevc", colorPrimaries: "bt2020", colorTransfer: "arib-std-b67",
  matrixCoefficients: "bt2020nc", colorRange: "limited", width: 160, height: 90,
  dolbyMetadata: { profile: "8.4", rpuPresent: true }
};
const gpuFilters = new Set(["libplacebo"]);

test("all HDR types use adaptive libplacebo and perceptual gamut mapping", () => {
  for (const contract of [hdr, { ...hdr, colorTransfer: "smpte2084", dolbyMetadata: { profile: "8.1", rpuPresent: true } },
    { ...hdr, dolbyMetadata: {} }]) {
    const conversion = buildDolbySdrConversion(contract, gpuFilters);
    assert.equal(conversion.engine, "libplacebo");
    assert.match(conversion.filter, /peak_detect=true/);
    assert.match(conversion.filter, /gamut_mode=perceptual/);
    assert.match(conversion.filter, /tonemapping=bt.2390/);
    assert.match(conversion.filter, /smoothing_period=20/);
    assert.doesNotMatch(conversion.filter, /hable|:peak=/);
    const args = buildSdrEncodeArgs("original.mov", "sdr.mp4", conversion);
    assert.equal(args[args.indexOf("-i") + 1], "original.mov");
    assert.equal(args.at(-1), "sdr.mp4");
  }
});

test("missing libplacebo fails instead of silently falling back to fixed CPU tone mapping", () => {
  assert.throws(() => buildDolbySdrConversion(hdr, new Set(["zscale", "tonemap"])), /libplacebo/);
});

test("Dolby conversion requires embedded RPU and rejects enhancement-layer reconstruction", () => {
  const p5 = { ...hdr, colorTransfer: "smpte2084", dolbyMetadata: { profile: "5", rpuPresent: true } };
  assert.equal(buildDolbySdrConversion(p5, gpuFilters).usesDolbyMetadata, true);
  assert.throws(() => buildDolbySdrConversion({ ...p5, dolbyMetadata: { profile: "5" } }, gpuFilters), /embedded RPU/);
  assert.throws(() => buildDolbySdrConversion({ ...p5, dolbyMetadata: { profile: "7", rpuPresent: true, elPresent: true } }, gpuFilters), /single-layer/);
});

test("SDR output must be real 8-bit AVC/BT.709 with no HDR metadata and unchanged dimensions", () => {
  const sdr = {
    codecName: "h264", colorPrimaries: "bt709", colorTransfer: "bt709",
    matrixCoefficients: "bt709", colorRange: "limited", pixelFormat: "yuv420p",
    bitDepth: 8, hlsVideoRange: "SDR", width: 160, height: 90,
    dolbyMetadata: {}, hdrStaticMetadata: {}
  };
  assert.deepEqual(validateSdrDerivative(sdr, hdr), []);
  for (const patch of [
    { colorTransfer: "arib-std-b67" }, { colorPrimaries: "bt2020" },
    { bitDepth: 10 }, { width: 80 }, { dolbyMetadata: { rpuPresent: true } },
    { hdrStaticMetadata: { masteringDisplayPresent: true } }
  ]) assert.ok(validateSdrDerivative({ ...sdr, ...patch }, hdr).length);
});

test("SDR dimension checks account for display rotation without allowing resizing", () => {
  const output = {
    codecName: "h264", colorPrimaries: "bt709", colorTransfer: "bt709",
    matrixCoefficients: "bt709", colorRange: "limited", pixelFormat: "yuv420p",
    bitDepth: 8, hlsVideoRange: "SDR", width: 90, height: 160
  };
  // FFmpeg bakes quarter-turn metadata into the pixels and clears the rotation.
  for (const rotation of [-270, -90, 90, 270]) {
    const probe = { side_data_list: [{ side_data_type: "Display Matrix", rotation }] };
    assert.deepEqual(validateSdrDerivative(output, hdr, probe), []);
    assert.ok(validateSdrDerivative({ ...output, width: 45 }, hdr, probe).length);
    assert.ok(validateSdrDerivative({ ...output, width: 160, height: 90 }, hdr, probe).length);
  }
  assert.deepEqual(validateSdrDerivative(output, hdr, { tags: { rotate: "90" } }), []);
  assert.ok(validateSdrDerivative(output, hdr).length);
  assert.deepEqual(validateSdrDerivative({ ...output, width: 160, height: 90 }, hdr,
    { side_data_list: [{ side_data_type: "Display Matrix", rotation: 180 }] }), []);
});
