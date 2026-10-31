const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateFilmBase, aggregateFilmBaseEstimates } = require("../src/film-scan-utils.cjs");
const base = [210, 156, 100];
function strip({ vertical = false, contamination = null, textured = false } = {}) {
  const width = vertical ? 120 : 240;
  const height = vertical ? 240 : 120;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const major = vertical ? y : x;
      const cross = vertical ? x : y;
      const gap = major < 30 || major >= 210;
      const scene = textured && (x + y) % 2 ? [50, 25, 10] : [95, 55, 30];
      const rgb = gap ? (contamination && cross % 5 === 0 ? contamination : base) : scene;
      rgb.forEach((value, channel) => { data[(y * width + x) * 3 + channel] = value; });
    }
  }
  return {
    raw: { data, width, height, channels: 3 },
    crop: vertical ? { x: 0, y: 0.125, width: 1, height: 0.75 } : { x: 0.125, y: 0, width: 0.75, height: 1 }
  };
}
function assertRgb(actual, expected) {
  actual.forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) < 1e-9, JSON.stringify(actual)));
}
for (const vertical of [false, true]) {
  test((vertical ? "vertical" : "horizontal") + " reliable gap beats a cleaner but darker scene border", () => {
    const { raw, crop } = strip({ vertical, contamination: [30, 20, 10] });
    const result = estimateFilmBase(raw, crop);
    assert.equal(result.source, "gap");
    assert.ok(result.confidence >= 0.85);
    assertRgb(result.rgb, base.map(v => v / 255));
  });
  for (const contamination of [[255, 255, 255], [236, 233, 230]]) {
    test((vertical ? "vertical" : "horizontal") + " keeps true base mixed with 20% scanner light " + contamination, () => {
      const { raw, crop } = strip({ vertical, contamination, textured: true });
      const result = estimateFilmBase(raw, crop);
      assert.equal(result.source, "gap");
      assert.ok(result.confidence >= 0.85);
      assertRgb(result.rgb, base.map(v => v / 255));
      assert.ok(result.support <= 0.81, "rejected contamination still counts against support");
    });
  }
}

test("implicit RGB channels match explicit channels", () => {
  const { raw, crop } = strip();
  const { channels, ...implicit } = raw;
  assert.deepEqual(estimateFilmBase(implicit, crop), estimateFilmBase(raw, crop));
});

test("fully clipped, neutral light and blocked images never become confident masks", () => {
  for (const rgb of [[255, 255, 255], [236, 233, 230], [0, 0, 0], [255, 156, 100]]) {
    const raw = { width: 64, height: 64, data: Buffer.from(Array.from({ length: 4096 }, () => rgb).flat()) };
    const result = estimateFilmBase(raw);
    assert.ok(result.confidence < 0.85);
    assert.ok(result.rgb.every(Number.isFinite));
  }
});

test("two inconsistent masks are rejected instead of synthesizing a mixed mask", () => {
  assert.equal(aggregateFilmBaseEstimates([[0.9, 0.55, 0.3], [0.7, 0.65, 0.4]]), null);
});

test("consistent even-sized samples average the two central values", () => {
  assertRgb(aggregateFilmBaseEstimates([[0.8, 0.6, 0.4], [0.82, 0.61, 0.39]]), [0.81, 0.605, 0.395]);
});

test("a strict majority rejects outliers before computing its median", () => {
  const values = [[0.8, 0.6, 0.4], [0.82, 0.61, 0.39], [0.5, 0.2, 0.1]];
  assertRgb(aggregateFilmBaseEstimates(values), [0.81, 0.605, 0.395]);
  assertRgb(aggregateFilmBaseEstimates([...values].reverse()), [0.81, 0.605, 0.395]);
});

test("equally split clusters and invalid estimates cannot produce an automatic roll mask", () => {
  assert.equal(aggregateFilmBaseEstimates([[0.8, 0.6, 0.4], [0.81, 0.61, 0.4], [0.5, 0.3, 0.1], [0.51, 0.31, 0.1]]), null);
  assert.equal(aggregateFilmBaseEstimates([[NaN, 0.6, 0.4], [1.2, 0.6, 0.4], [null, 0.6, 0.4]]), null);
});
