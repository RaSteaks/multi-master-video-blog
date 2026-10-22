const test = require("node:test");
const assert = require("node:assert/strict");
const { createRpuHasher, compareHdrMetadata } = require("../src/video-integrity.cjs");

test("RPU hashes ignore Annex B framing and other NALs but detect missing or modified RPU", () => {
  const payload = Buffer.from([0x7c, 1, 0x19, 9, 3, 0x80]);
  const digest = (start, corrupt = false, omit = false) => {
    const scanner = createRpuHasher();
    const bytes = Buffer.concat([Buffer.from(start), Buffer.from([0x26, 1, 0x80]),
      ...(omit ? [] : [Buffer.from(start), Buffer.from(corrupt ? [...payload.subarray(0, -1), 0x81] : payload)])]);
    // Split start codes and RPU data across stdout chunks as real child processes can.
    for (let i = 0; i < bytes.length; i++) scanner.write(bytes.subarray(i, i + 1));
    return scanner.finish();
  };
  const base = digest([0, 0, 1]);
  assert.equal(base.count, 1);
  assert.deepEqual(digest([0, 0, 0, 1]), base);
  assert.notEqual(digest([0, 0, 1], true).sha256, base.sha256);
  assert.equal(digest([0, 0, 1], false, true).count, 0);
});

test("copy metadata checks include static values and actual RPU content", () => {
  const base = { hdrStaticMetadata: { masteringDisplay: { max_luminance: "40000000/10000" },
    contentLightLevel: { max_content: 4000, max_average: 400 } },
  dolbyMetadata: { profile: "8.1", level: "6", compatibilityId: "1", rpuPresent: true,
    blPresent: true, elPresent: false, rpuCount: 24, rpuSha256: "original" } };
  assert.deepEqual(compareHdrMetadata(base, { ...base,
    hdrStaticMetadata: { ...base.hdrStaticMetadata, masteringDisplay: { max_luminance: "4000/1" } } }), []);
  for (const patch of [{ rpuPresent: false }, { rpuCount: 23 }, { rpuSha256: "changed" }, { compatibilityId: "4" }]) {
    assert.ok(compareHdrMetadata(base, { ...base, dolbyMetadata: { ...base.dolbyMetadata, ...patch } }).length);
  }
  assert.ok(compareHdrMetadata(base, { ...base, hdrStaticMetadata: {} }).length);
});
