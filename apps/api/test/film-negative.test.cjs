const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const sharp = require("sharp");
const { srgbToLinear, linearToSrgb, negativeChannel, buildNegativeDensityFilter } = require("../src/film-negative.cjs");
const { applyFilmPipeline, normalizeFilmScanMetadata } = require("../src/film-scan-utils.cjs");
const mask = [0.82, 0.61, 0.39];
test("physical neutral wedge stays neutral from film base through high densities", () => {
  let last = -1;
  for (const density of [0, 0.1, 0.3, 0.6, 1, 1.5, 2, 2.4, 3]) {
    const result = mask.map(base => negativeChannel(linearToSrgb(srgbToLinear(base) * 10 ** -density), base));
    assert.ok(Math.max(...result) - Math.min(...result) < 1e-8);
    assert.ok(result[0] > last && result[0] < 1);
    last = result[0];
  }
});
test("production FFmpeg and Sharp negative paths agree on a 16-bit neutral wedge", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "film-density-test-"));
  try {
    const densities = [0, 0.1, 0.3, 0.6, 1, 1.5, 2];
    const pixels = Uint16Array.from(densities.flatMap(d => mask.map(base => Math.round(linearToSrgb(srgbToLinear(base) * 10 ** -d) * 65535))));
    const source = path.join(dir, "negative.tif");
    const output = path.join(dir, "positive.tif");
    await sharp(new Uint16Array([...pixels,...pixels]), { raw: { width: densities.length, height: 2, channels: 3 } }).toColourspace("rgb16").tiff({ compression: "deflate" }).toFile(source);
    await promisify(execFile)(require("ffmpeg-static"), ["-y", "-v", "error", "-i", source, "-vf", buildNegativeDensityFilter(mask), "-frames:v", "1", "-c:v", "tiff", "-pix_fmt", "rgb48le", output], { windowsHide: true });
    const rendered = await sharp(output).toColourspace("rgb16").raw({ depth: "ushort" }).toBuffer();
    const alternate = await (await applyFilmPipeline(sharp(source), "color-negative", { highlightRolloff: 0 }, mask)).toColourspace("rgb16").raw({ depth: "ushort" }).toBuffer();
    for (let i = 0; i < pixels.length; i++) {
      const expected = negativeChannel(pixels[i] / 65535, mask[i % 3]);
      assert.ok(Math.abs(rendered.readUInt16LE(i * 2) / 65535 - expected) < 0.0001, 'FFmpeg sample ' + i);
      assert.ok(Math.abs(alternate.readUInt16LE(i * 2) / 65535 - expected) < 0.0001, 'Sharp sample ' + i);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("exposure and levels both affect rendered output, including default rolloff", async () => {
  const render = async adjustments => (await applyFilmPipeline(sharp(Buffer.from([60,60,60]), { raw: {width:1,height:1,channels:3} }), "slide", adjustments)).raw().toBuffer();
  const normal = await render({});
  const brighter = await render({exposure: 1});
  assert.ok(brighter[0] > normal[0] + 20);
  const combined = await render({exposure: 1, whitePoint: [0.8,0.8,0.8], highlightRolloff: 0});
  assert.ok(Math.abs(combined[0] - 150) <= 1);
});
test("push/pull preserves signed and fractional development metadata", () => {
  for (const pushPull of [-2, -0.5, 0, 0.5, 2]) {
    const result = normalizeFilmScanMetadata({scanner:"hasselblad-x5",frameFormat:"135-full",filmType:"color-negative",filmStock:"Portra 400",process:"c41",pushPull});
    assert.equal(result.pushPull, pushPull);
    assert.equal(result.adjustments.exposure, 0);
  }
});

test("film base confidence rejects textured, blocked and clipped borders", () => {
  const { estimateFilmBase } = require("../src/film-scan-utils.cjs");
  const image = rgb => ({ width: 64, height: 64, channels: 3, data: Buffer.from(Array.from({length:4096}, () => rgb).flat()) });
  assert.ok(estimateFilmBase(image([210,156,100])).confidence >= 0.85);
  assert.ok(estimateFilmBase(image([0,0,0])).confidence < 0.85);
  assert.ok(estimateFilmBase(image([255,255,255])).confidence < 0.85);
  const textured = image([210,156,100]);
  for (let i=0;i<textured.data.length;i+=6) textured.data.fill(30,i,i+3);
  assert.ok(estimateFilmBase(textured).confidence < 0.85);
});

test("PNG film output really retains 16-bit depth", async () => {
  const { renderFilmFrame } = require("../src/film-scan-utils.cjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "film-png-test-"));
  try {
    const sourcePath = path.join(dir, "source.tif");
    const outputPath = path.join(dir, "output.png");
    await sharp(new Uint16Array([12345,23456,34567]), {raw:{width:1,height:1,channels:3}})
      .toColourspace("rgb16").tiff({compression:"deflate"}).toFile(sourcePath);
    await renderFilmFrame({sourcePath,outputPath,crop:{x:0,y:0,width:1,height:1},filmType:"slide",adjustments:{highlightRolloff:0},outputFormat:"png16"});
    assert.equal((await sharp(outputPath).metadata()).depth, "ushort");
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
