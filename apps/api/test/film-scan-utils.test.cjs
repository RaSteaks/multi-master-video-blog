const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FILM_FRAME_ASPECTS,
  assessFilmFrameDynamicRange,
  demaskRgb,
  detectFilmFrames,
  detectFilmScanSignature,
  mergeFrameAdjustments,
  normalizeAdjustments,
  normalizeFilmScanMetadata,
  validateFilmScanUpload
} = require("../src/film-scan-utils.cjs");

test("manual film-base samples preserve source identity and highlight rolloff", () => {
  const adjustments = normalizeAdjustments({
    maskMode: "manual",
    filmBaseSample: { x: 0.25, y: 0.75, sourceId: 42 },
    highlightRolloff: 0.72
  });
  assert.deepEqual(adjustments.filmBaseSample, {
    x: 0.25,
    y: 0.75,
    sourceId: 42
  });
  assert.equal(adjustments.highlightRolloff, 0.72);
});

test("HDR eligibility rejects flat scans and accepts broad continuous tone", () => {
  const width = 256;
  const height = 32;
  const channels = 3;
  const broad = Buffer.alloc(width * height * channels);
  const flat = Buffer.alloc(width * height * channels, 128);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      broad[offset] = x;
      broad[offset + 1] = x;
      broad[offset + 2] = x;
    }
  }
  assert.equal(
    assessFilmFrameDynamicRange({ data: flat, width, height, channels }).eligible,
    false
  );
  assert.equal(
    assessFilmFrameDynamicRange({ data: broad, width, height, channels }).eligible,
    true
  );
});

function syntheticStrip(frameFormat, count, vertical = false) {
  const aspect = FILM_FRAME_ASPECTS[frameFormat];
  const shortSide = 120;
  const frameLong = Math.round(shortSide * aspect);
  const gap = 18;
  const major = count * frameLong + (count + 1) * gap;
  const width = vertical ? shortSide : major;
  const height = vertical ? major : shortSide;
  const channels = 3;
  const data = Buffer.alloc(width * height * channels, 8);
  for (let frame = 0; frame < count; frame += 1) {
    const start = gap + frame * (frameLong + gap);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const majorPosition = vertical ? y : x;
        if (majorPosition < start || majorPosition >= start + frameLong) continue;
        const value = 45 + ((x * 17 + y * 31 + frame * 43) % 175);
        const offset = (y * width + x) * channels;
        data[offset] = value;
        data[offset + 1] = (value + 27) % 255;
        data[offset + 2] = (value + 59) % 255;
      }
    }
  }
  return { data, width, height, channels };
}

test("recognizes TIFF-signature Flextight files and rejects camera-like payloads", () => {
  const signature = detectFilmScanSignature(Buffer.from([0x49, 0x49, 0x2a, 0x00]));
  assert.equal(signature, "image/tiff");
  assert.equal(
    validateFilmScanUpload({
      filename: "roll.fff",
      declaredMime: "application/octet-stream",
      signature
    }).experimental,
    true
  );
  assert.throws(
    () =>
      validateFilmScanUpload({
        filename: "camera.fff",
        declaredMime: "application/octet-stream",
        signature: "image/jpeg"
      }),
    /TIFF/
  );
});

test("treats browser-declared MIME as advisory for valid FFF content", () => {
  for (const declaredMime of [
    "",
    "application/octet-stream",
    "application/x-fff",
    "image/x-hasselblad-fff",
    "image/x-tiff",
    "image/jpeg"
  ]) {
    const result = validateFilmScanUpload({
      filename: "1003.fff",
      declaredMime,
      signature: "image/tiff"
    });
    assert.equal(result.format, "fff");
    assert.equal(result.mimeType, "image/tiff");
  }
});

test("still rejects forged film-scan extensions by their detected signature", () => {
  assert.throws(
    () =>
      validateFilmScanUpload({
        filename: "forged.tiff",
        declaredMime: "image/tiff",
        signature: "image/jpeg"
      }),
    /TIFF 扩展名与文件签名不匹配/
  );
  assert.throws(
    () =>
      validateFilmScanUpload({
        filename: "forged.jpeg",
        declaredMime: "image/jpeg",
        signature: "image/tiff"
      }),
    /JPEG 扩展名与文件签名不匹配/
  );
});

for (const frameFormat of Object.keys(FILM_FRAME_ASPECTS)) {
  for (const vertical of [false, true]) {
    test(`detects ${frameFormat} frames in ${vertical ? "vertical" : "horizontal"} strips`, () => {
      const frames = detectFilmFrames(syntheticStrip(frameFormat, 3, vertical), {
        frameFormat
      });
      assert.equal(frames.length, 3);
      assert.ok(frames.every((frame) => frame.crop.width > 0 && frame.crop.height > 0));
    });
  }
}

test("frame overrides inherit unspecified whole-roll adjustments", () => {
  const merged = mergeFrameAdjustments(
    { exposure: 0.5, saturation: 0.2, temperature: -0.1 },
    { exposure: 1.25 }
  );
  assert.equal(merged.exposure, 1.25);
  assert.equal(merged.saturation, 0.2);
  assert.equal(merged.temperature, -0.1);
});

test("film metadata validates supported scanner, process, and format", () => {
  const metadata = normalizeFilmScanMetadata({
    scanner: "hasselblad-x5",
    frameFormat: "120-67",
    filmType: "color-negative",
    filmStock: "Kodak Portra 400",
    iso: 400,
    process: "c41",
    pushPull: 1
  });
  assert.equal(metadata.filmStock, "Kodak Portra 400");
  assert.equal(metadata.pushPull, 1);
  assert.throws(
    () => normalizeFilmScanMetadata({ ...metadata, scanner: "unknown" }),
    /扫描仪/
  );
});

test("optical-density demask keeps neutral film-base sample near black", () => {
  const mask = [0.82, 0.61, 0.39];
  const output = demaskRgb(mask, mask);
  assert.ok(output.every((channel) => channel < 0.001));
  const denser = demaskRgb([0.2, 0.15, 0.1], mask);
  assert.ok(denser.every((channel) => channel > 0.1));
});

test("synthetic frame crops reach IoU 0.95 or better", () => {
  const strip = syntheticStrip("135-full", 3, false);
  const frames = detectFilmFrames(strip, { frameFormat: "135-full" });
  const expectedFrameWidth = Math.round(120 * FILM_FRAME_ASPECTS["135-full"]);
  for (let index = 0; index < frames.length; index += 1) {
    const expected = {
      x: (18 + index * (expectedFrameWidth + 18)) / strip.width,
      width: expectedFrameWidth / strip.width
    };
    const actual = frames[index].crop;
    const intersection = Math.max(
      0,
      Math.min(actual.x + actual.width, expected.x + expected.width) -
        Math.max(actual.x, expected.x)
    );
    const union = actual.width + expected.width - intersection;
    assert.ok(intersection / union >= 0.95);
  }
});

test("single-frame scans are cropped once instead of split by internal texture", () => {
  const width = 300;
  const height = 200;
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const border = x < 12 || x >= width - 12 || y < 12 || y >= height - 12;
      const value = border ? 18 : 45 + ((x * 13 + y * 17) % 175);
      data[offset] = value;
      data[offset + 1] = border ? 18 : (value + 31) % 255;
      data[offset + 2] = border ? 18 : (value + 67) % 255;
    }
  }
  const frames = detectFilmFrames(
    { data, width, height, channels },
    { frameFormat: "135-full" }
  );
  assert.equal(frames.length, 1);
  assert.ok(frames[0].crop.width > 0.85);
  assert.ok(frames[0].crop.height > 0.85);
});

test("neutral negative remains within Delta E 2000 of 3 after demasking", () => {
  const mask = [0.82, 0.61, 0.39];
  const scannedGrey = mask.map((channel) => channel * 0.42);
  const corrected = demaskRgb(scannedGrey, mask);
  const lab = rgbToLab(corrected);
  const neutral = rgbToLab([
    corrected.reduce((sum, channel) => sum + channel, 0) / 3,
    corrected.reduce((sum, channel) => sum + channel, 0) / 3,
    corrected.reduce((sum, channel) => sum + channel, 0) / 3
  ]);
  assert.ok(deltaE00(lab, neutral) <= 3);
});

function rgbToLab(rgb) {
  const linear = rgb.map((value) =>
    value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4
  );
  const x = (linear[0] * 0.4124 + linear[1] * 0.3576 + linear[2] * 0.1805) / 0.95047;
  const y = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const z = (linear[0] * 0.0193 + linear[1] * 0.1192 + linear[2] * 0.9505) / 1.08883;
  const pivot = (value) =>
    value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE00(left, right) {
  const [l1, a1, b1] = left;
  const [l2, a2, b2] = right;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const averageC = (c1 + c2) / 2;
  const g =
    0.5 *
    (1 - Math.sqrt(averageC ** 7 / (averageC ** 7 + 25 ** 7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);
  const hue = (a, b) => {
    const degrees = (Math.atan2(b, a) * 180) / Math.PI;
    return degrees >= 0 ? degrees : degrees + 360;
  };
  const h1Prime = hue(a1Prime, b1);
  const h2Prime = hue(a2Prime, b2);
  const deltaL = l2 - l1;
  const deltaC = c2Prime - c1Prime;
  let deltaHue = h2Prime - h1Prime;
  if (c1Prime * c2Prime === 0) deltaHue = 0;
  else if (deltaHue > 180) deltaHue -= 360;
  else if (deltaHue < -180) deltaHue += 360;
  const deltaH =
    2 * Math.sqrt(c1Prime * c2Prime) * Math.sin((deltaHue * Math.PI) / 360);
  const averageL = (l1 + l2) / 2;
  const averageCPrime = (c1Prime + c2Prime) / 2;
  let averageHue = h1Prime + h2Prime;
  if (c1Prime * c2Prime === 0) {
    averageHue = h1Prime + h2Prime;
  } else if (Math.abs(h1Prime - h2Prime) <= 180) {
    averageHue = (h1Prime + h2Prime) / 2;
  } else if (h1Prime + h2Prime < 360) {
    averageHue = (h1Prime + h2Prime + 360) / 2;
  } else {
    averageHue = (h1Prime + h2Prime - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(((averageHue - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * averageHue * Math.PI) / 180) +
    0.32 * Math.cos(((3 * averageHue + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * averageHue - 63) * Math.PI) / 180);
  const sl = 1 + (0.015 * (averageL - 50) ** 2) / Math.sqrt(20 + (averageL - 50) ** 2);
  const sc = 1 + 0.045 * averageCPrime;
  const sh = 1 + 0.015 * averageCPrime * t;
  const rotation =
    30 * Math.exp(-(((averageHue - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(averageCPrime ** 7 / (averageCPrime ** 7 + 25 ** 7));
  const rt = -rc * Math.sin((2 * rotation * Math.PI) / 180);
  const lightness = deltaL / sl;
  const chroma = deltaC / sc;
  const hueTerm = deltaH / sh;
  return Math.sqrt(
    lightness ** 2 + chroma ** 2 + hueTerm ** 2 + rt * chroma * hueTerm
  );
}
