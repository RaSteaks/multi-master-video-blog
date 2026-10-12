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

test("automatic film base prefers inter-frame gaps and tolerates edge markings", () => {
  const { estimateFilmBase } = require("../src/film-scan-utils.cjs");
  const base = [212, 158, 96];
  for (const vertical of [false, true]) {
    const frameLength = 180;
    const shortSide = 120;
    const gap = 24;
    const major = frameLength + 2 * gap;
    const width = vertical ? shortSide : major;
    const height = vertical ? major : shortSide;
    const channels = 3;
    const data = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const majorPosition = vertical ? y : x;
        const offset = (y * width + x) * channels;
        if (majorPosition >= gap && majorPosition < gap + frameLength) {
          // Darker scene content inside the frame must not win over the gaps.
          data[offset] = 60 + ((x * 7 + y * 13) % 70);
          data[offset + 1] = 40 + ((x * 5 + y * 11) % 60);
          data[offset + 2] = 25 + ((x * 3 + y * 9) % 40);
        } else {
          data[offset] = base[0];
          data[offset + 1] = base[1];
          data[offset + 2] = base[2];
        }
      }
    }
    // Frame-number ink in the trailing gap band: dark contamination.
    const trailingStart = gap + frameLength + 2;
    for (let majorPosition = trailingStart; majorPosition < trailingStart + 10; majorPosition += 2) {
      for (let cross = 40; cross < 80; cross += 1) {
        const x = vertical ? cross : majorPosition;
        const y = vertical ? majorPosition : cross;
        const offset = (y * width + x) * channels;
        data[offset] = 48;
        data[offset + 1] = 30;
        data[offset + 2] = 18;
      }
    }
    const crop = vertical
      ? { x: 0, y: gap / major, width: 1, height: frameLength / major }
      : { x: gap / major, y: 0, width: frameLength / major, height: 1 };
    const result = estimateFilmBase({ data, width, height, channels }, crop);
    assert.equal(result.source, "gap", vertical ? "vertical" : "horizontal");
    assert.ok(result.confidence >= 0.85, `confidence ${result.confidence}`);
    result.rgb.forEach((channel, index) => {
      assert.ok(
        Math.abs(channel - base[index] / 255) < 0.02,
        `channel ${index}: ${channel}`
      );
    });
  }
});

test("desaturated scanner light through holders is not accepted as film base", () => {
  const { estimateFilmBase } = require("../src/film-scan-utils.cjs");
  const image = rgb => ({ width: 64, height: 64, channels: 3, data: Buffer.from(Array.from({length:4096}, () => rgb).flat()) });
  assert.ok(estimateFilmBase(image([236, 233, 230])).confidence < 0.85);
  // A thin but genuinely chromatic mask is still usable.
  assert.ok(estimateFilmBase(image([188, 172, 152])).confidence >= 0.85);
});

test("roll mask aggregates the agreeing majority by per-channel median", () => {
  const { aggregateFilmBaseEstimates } = require("../src/film-scan-utils.cjs");
  const aggregated = aggregateFilmBaseEstimates([[0.8, 0.6, 0.4], [0.82, 0.61, 0.39], [0.5, 0.2, 0.1]]);
  [0.81, 0.605, 0.395].forEach((expected, channel) => {
    assert.ok(Math.abs(aggregated[channel] - expected) < 1e-9);
  });
  assert.deepEqual(
    aggregateFilmBaseEstimates([[0.7, 0.5, 0.3]]),
    [0.7, 0.5, 0.3]
  );
  assert.equal(aggregateFilmBaseEstimates([]), null);
  assert.equal(aggregateFilmBaseEstimates(null), null);
  assert.equal(aggregateFilmBaseEstimates([[0.8, 0.6]]), null);
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
