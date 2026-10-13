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
const cpuFilters = new Set(["zscale", "tonemap"]);

test("P8.4 explicitly decodes HLG into linear light and maps into BT.709", () => {
  const conversion = buildDolbySdrConversion(hdr, cpuFilters);
  assert.match(conversion.filter, /transferin=arib-std-b67/);
  assert.match(conversion.filter, /transfer=linear/);
  assert.match(conversion.filter, /tonemap=tonemap=hable/);
  assert.match(conversion.filter, /primaries=bt709/);
  assert.equal(conversion.usesDolbyMetadata, false);
  const args = buildSdrEncodeArgs("original.mov", "sdr.mp4", conversion);
  assert.equal(args[args.indexOf("-i") + 1], "original.mov");
  assert.equal(args.at(-1), "sdr.mp4");
  assert.ok(args.includes("0:a?"));
});

test("P8.1 uses PQ and measured MaxCLL for tone mapping", () => {
  const conversion = buildDolbySdrConversion({
    ...hdr, colorTransfer: "smpte2084", dolbyMetadata: { profile: "8.1" },
    hdrStaticMetadata: { contentLightLevel: { max_content: 2000 } }
  }, cpuFilters);
  assert.match(conversion.filter, /transferin=smpte2084/);
  assert.match(conversion.filter, /peak=20/);
});

test("missing tone-mapping filters cannot silently produce a retagged SDR", () => {
  assert.throws(() => buildDolbySdrConversion(hdr, new Set()), /zscale and tonemap/);
});

test("P5 requires a Dolby-aware path rather than treating its pixels as PQ YCbCr", () => {
  const p5 = { ...hdr, colorTransfer: "smpte2084", dolbyMetadata: { profile: "5", rpuPresent: true } };
  assert.throws(() => buildDolbySdrConversion(p5, cpuFilters), /libplacebo/);
  const conversion = buildDolbySdrConversion(p5, new Set(["libplacebo"]));
  assert.equal(conversion.usesDolbyMetadata, true);
  assert.match(conversion.filter, /apply_dolbyvision=true/);
  assert.ok(buildSdrEncodeArgs("dv.mp4", "sdr.mp4", conversion).includes("vulkan"));
  assert.throws(() => buildDolbySdrConversion({ ...p5, dolbyMetadata: { profile: "5" } },
    new Set(["libplacebo"])), /embedded RPU/);
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
