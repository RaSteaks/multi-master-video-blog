const fs = require("node:fs/promises");
const path = require("node:path");

const FILM_SCAN_JOB_STATES = Object.freeze([
  "uploaded",
  "analyzing",
  "review_required",
  "rendering",
  "committed",
  "failed",
  "canceled"
]);

const FILM_FRAME_ASPECTS = Object.freeze({
  "135-full": 36 / 24,
  "135-half": 24 / 18,
  "135-pano": 65 / 24,
  "120-645": 60 / 45,
  "120-66": 1,
  "120-67": 70 / 60,
  "120-68": 80 / 60,
  "120-69": 90 / 60
});

const DEFAULT_ROLL_ADJUSTMENTS = Object.freeze({
  maskMode: "auto",
  maskRgb: null,
  filmBaseSample: null,
  exposure: 0,
  temperature: 0,
  tint: 0,
  blackPoint: [0, 0, 0],
  whitePoint: [1, 1, 1],
  contrast: 0,
  saturation: 0,
  highlightRolloff: 0.25
});

const SCANNERS = new Set(["hasselblad-x5", "fujifilm-sp3000", "noritsu-hs1800"]);
const FILM_TYPES = new Set(["color-negative", "bw-negative", "slide"]);
const PROCESSES = new Set(["c41", "e6", "ecn2", "bw", "other"]);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(Math.round((sorted.length - 1) * fraction), 0, sorted.length - 1);
  return sorted[index];
}

function detectFilmScanSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const littleEndianTiff =
    buffer[0] === 0x49 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x2a &&
    buffer[3] === 0x00;
  const bigEndianTiff =
    buffer[0] === 0x4d &&
    buffer[1] === 0x4d &&
    buffer[2] === 0x00 &&
    buffer[3] === 0x2a;
  if (littleEndianTiff || bigEndianTiff) return "image/tiff";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

function validateFilmScanUpload({ filename, signature }) {
  const extension = path.extname(String(filename || "")).toLowerCase();
  const isFff = extension === ".fff" || extension === ".3f";
  const allowedExtension = [".fff", ".3f", ".tif", ".tiff", ".jpg", ".jpeg"].includes(
    extension
  );
  if (!allowedExtension) {
    throw new Error("仅支持 FFF/3F、TIFF 和 JPEG 胶片扫描文件。");
  }
  if (!signature) {
    throw new Error("文件签名不是受支持的 TIFF 或 JPEG。");
  }
  if (isFff && signature !== "image/tiff") {
    throw new Error("Flextight FFF/3F 必须具有 TIFF 文件签名。");
  }
  if ([".tif", ".tiff"].includes(extension) && signature !== "image/tiff") {
    throw new Error("TIFF 扩展名与文件签名不匹配。");
  }
  if ([".jpg", ".jpeg"].includes(extension) && signature !== "image/jpeg") {
    throw new Error("JPEG 扩展名与文件签名不匹配。");
  }
  // Multipart MIME is supplied by the browser and is not authoritative. Raw
  // formats such as FFF are reported inconsistently across Edge, Safari and
  // Chrome, so validation relies on the extension plus the detected signature.
  return {
    extension,
    format: isFff ? "fff" : signature === "image/tiff" ? "tiff" : "jpeg",
    mimeType: signature,
    experimental: isFff
  };
}

function normalizeFilmScanMetadata(input = {}) {
  const scanner = String(input.scanner || "").trim().toLowerCase();
  const frameFormat = String(input.frameFormat || input.frame_format || "").trim().toLowerCase();
  const filmType = String(input.filmType || input.film_type || "").trim().toLowerCase();
  const process = String(input.process || "").trim().toLowerCase();
  if (!SCANNERS.has(scanner)) throw new Error("请选择受支持的扫描仪。");
  if (!Object.hasOwn(FILM_FRAME_ASPECTS, frameFormat)) {
    throw new Error("请选择受支持的 135 或 120 画幅。");
  }
  if (!FILM_TYPES.has(filmType)) throw new Error("请选择胶卷类型。");
  if (!PROCESSES.has(process)) throw new Error("请选择冲洗工艺。");

  const stock = String(input.filmStock || input.film_stock || "").trim();
  if (!stock) throw new Error("胶卷型号不能为空。");
  const iso = clamp(Number(input.iso || 100), 1, 25600);
  const pushPull = clamp(Number(input.pushPull ?? input.push_pull ?? 0), -5, 5);
  return {
    scanner,
    frameFormat,
    filmType,
    filmStock: stock.slice(0, 160),
    iso,
    process,
    pushPull,
    adjustments: normalizeAdjustments(input.adjustments)
  };
}

function normalizeTriplet(value, fallback) {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return value.map((item, index) =>
    clamp(Number.isFinite(Number(item)) ? Number(item) : fallback[index], 0, 1)
  );
}

function normalizePoint(value) {
  if (!value || typeof value !== "object") return null;
  const point = {
    x: clamp(value.x, 0, 1),
    y: clamp(value.y, 0, 1)
  };
  const sourceId = Number(value.sourceId ?? value.source_id);
  if (Number.isInteger(sourceId) && sourceId > 0) point.sourceId = sourceId;
  return point;
}

function normalizeAdjustments(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const maskRgb =
    Array.isArray(source.maskRgb) && source.maskRgb.length === 3
      ? normalizeTriplet(source.maskRgb, [0.8, 0.6, 0.4])
      : null;
  return {
    maskMode: ["auto", "manual", "preset"].includes(source.maskMode)
      ? source.maskMode
      : DEFAULT_ROLL_ADJUSTMENTS.maskMode,
    maskRgb,
    filmBaseSample: normalizePoint(source.filmBaseSample),
    exposure: clamp(source.exposure || 0, -5, 5),
    temperature: clamp(source.temperature || 0, -1, 1),
    tint: clamp(source.tint || 0, -1, 1),
    blackPoint: normalizeTriplet(source.blackPoint, [0, 0, 0]),
    whitePoint: normalizeTriplet(source.whitePoint, [1, 1, 1]),
    contrast: clamp(source.contrast || 0, -1, 1),
    saturation: clamp(source.saturation || 0, -1, 2),
    highlightRolloff: clamp(
      source.highlightRolloff ?? DEFAULT_ROLL_ADJUSTMENTS.highlightRolloff,
      0,
      1
    )
  };
}

function mergeFrameAdjustments(rollAdjustments, frameOverride) {
  const base = normalizeAdjustments(rollAdjustments);
  if (!frameOverride || typeof frameOverride !== "object") return base;
  const merged = { ...base };
  for (const key of Object.keys(DEFAULT_ROLL_ADJUSTMENTS)) {
    if (Object.hasOwn(frameOverride, key)) merged[key] = frameOverride[key];
  }
  return normalizeAdjustments(merged);
}

function normalizeCrop(value = {}) {
  const x = clamp(value.x ?? 0, 0, 1);
  const y = clamp(value.y ?? 0, 0, 1);
  const width = clamp(value.width ?? 1, 0.005, 1 - x);
  const height = clamp(value.height ?? 1, 0.005, 1 - y);
  return { x, y, width, height };
}

function axisProfiles(data, width, height, channels, horizontal) {
  const major = horizontal ? width : height;
  const minor = horizontal ? height : width;
  const means = new Array(major).fill(0);
  const variances = new Array(major).fill(0);
  const stride = Math.max(1, Math.floor(minor / 320));
  for (let majorIndex = 0; majorIndex < major; majorIndex += 1) {
    let sum = 0;
    let squareSum = 0;
    let count = 0;
    for (let minorIndex = 0; minorIndex < minor; minorIndex += stride) {
      const x = horizontal ? majorIndex : minorIndex;
      const y = horizontal ? minorIndex : majorIndex;
      const offset = (y * width + x) * channels;
      const luminance =
        (Number(data[offset]) * 54 +
          Number(data[offset + Math.min(1, channels - 1)]) * 183 +
          Number(data[offset + Math.min(2, channels - 1)]) * 19) /
        256;
      sum += luminance;
      squareSum += luminance * luminance;
      count += 1;
    }
    const mean = count ? sum / count : 0;
    means[majorIndex] = mean;
    variances[majorIndex] = count ? Math.max(0, squareSum / count - mean * mean) : 0;
  }
  return { means, variances };
}

function runsFromActivity(activity, maxGap, minimumLength) {
  const runs = [];
  let start = -1;
  let lastActive = -1;
  for (let index = 0; index < activity.length; index += 1) {
    if (activity[index]) {
      if (start < 0) start = index;
      lastActive = index;
    } else if (start >= 0 && index - lastActive > maxGap) {
      if (lastActive - start + 1 >= minimumLength) runs.push([start, lastActive + 1]);
      start = -1;
      lastActive = -1;
    }
  }
  if (start >= 0 && lastActive - start + 1 >= minimumLength) {
    runs.push([start, lastActive + 1]);
  }
  return runs;
}

function detectFilmFrames(raw, options = {}) {
  const { data, width, height, channels = 3 } = raw || {};
  if (!data || !width || !height || channels < 1) {
    throw new Error("分析图像数据不完整。");
  }
  const horizontal = width >= height;
  const major = horizontal ? width : height;
  const minor = horizontal ? height : width;
  const { means, variances } = axisProfiles(data, width, height, channels, horizontal);
  const expectedAspect = FILM_FRAME_ASPECTS[options.frameFormat] || 1.5;
  const varianceLow = quantile(variances, 0.2);
  const varianceHigh = quantile(variances, 0.9);
  const meanLow = quantile(means, 0.1);
  const meanHigh = quantile(means, 0.9);
  const varianceThreshold = varianceLow + Math.max(4, (varianceHigh - varianceLow) * 0.18);
  const meanSpan = Math.max(8, meanHigh - meanLow);
  const activity = variances.map(
    (variance, index) =>
      variance >= varianceThreshold ||
      (means[index] > meanLow + meanSpan * 0.12 &&
        means[index] < meanHigh - meanSpan * 0.06)
  );
  const maxGap = Math.max(2, Math.round(major * 0.012));
  const minimumLength = Math.max(12, Math.round(minor * 0.35));
  let runs = runsFromActivity(activity, maxGap, minimumLength);

  if (major / minor <= expectedAspect * 1.35) {
    const crossProfiles = axisProfiles(
      data,
      width,
      height,
      channels,
      !horizontal
    );
    const crossVarianceLow = quantile(crossProfiles.variances, 0.2);
    const crossVarianceHigh = quantile(crossProfiles.variances, 0.9);
    const crossMeanLow = quantile(crossProfiles.means, 0.1);
    const crossMeanHigh = quantile(crossProfiles.means, 0.9);
    const crossVarianceThreshold =
      crossVarianceLow +
      Math.max(4, (crossVarianceHigh - crossVarianceLow) * 0.18);
    const crossMeanSpan = Math.max(8, crossMeanHigh - crossMeanLow);
    const crossActivity = crossProfiles.variances.map(
      (variance, index) =>
        variance >= crossVarianceThreshold ||
        (crossProfiles.means[index] > crossMeanLow + crossMeanSpan * 0.12 &&
          crossProfiles.means[index] < crossMeanHigh - crossMeanSpan * 0.06)
    );
    const crossRuns = runsFromActivity(
      crossActivity,
      Math.max(2, Math.round(minor * 0.012)),
      Math.max(8, Math.round(minor * 0.08))
    );
    const majorStart = runs.length ? runs[0][0] : 0;
    const majorEnd = runs.length ? runs.at(-1)[1] : major;
    const crossStart = crossRuns.length ? crossRuns[0][0] : 0;
    const crossEnd = crossRuns.length ? crossRuns.at(-1)[1] : minor;
    const crop = horizontal
      ? normalizeCrop({
          x: majorStart / width,
          y: crossStart / height,
          width: (majorEnd - majorStart) / width,
          height: (crossEnd - crossStart) / height
        })
      : normalizeCrop({
          x: crossStart / width,
          y: majorStart / height,
          width: (crossEnd - crossStart) / width,
          height: (majorEnd - majorStart) / height
        });
    const pixelAspect =
      Math.max(crop.width * width, crop.height * height) /
      Math.max(1, Math.min(crop.width * width, crop.height * height));
    const aspectError = Math.abs(pixelAspect - expectedAspect) / expectedAspect;
    const confidence = clamp(0.97 - aspectError * 0.45, 0.55, 0.99);
    return [
      {
        index: 0,
        crop,
        confidence,
        requiresConfirmation: confidence < 0.85
      }
    ];
  }

  const expectedMajorLength = Math.max(1, minor * expectedAspect);
  if (
    runs.length <= 1 &&
    major > expectedMajorLength * 1.65
  ) {
    const count = Math.max(1, Math.round(major / expectedMajorLength));
    const inset = Math.max(0, Math.round((major - count * expectedMajorLength) / 2));
    runs = Array.from({ length: count }, (_, index) => [
      Math.round(inset + index * expectedMajorLength),
      Math.min(major, Math.round(inset + (index + 1) * expectedMajorLength))
    ]);
  }
  if (!runs.length) runs = [[0, major]];

  return runs.map(([start, end], index) => {
    const padding = Math.max(1, Math.round((end - start) * 0.012));
    const paddedStart = clamp(start - padding, 0, major);
    const paddedEnd = clamp(end + padding, paddedStart + 1, major);
    const measuredAspect = (paddedEnd - paddedStart) / minor;
    const aspectError = Math.abs(measuredAspect - expectedAspect) / expectedAspect;
    const contrast =
      (varianceHigh - varianceLow) / Math.max(1, varianceHigh + varianceLow);
    const confidence = clamp(
      0.97 - aspectError * 0.45 - (contrast < 0.08 ? 0.18 : 0),
      0.35,
      0.99
    );
    return {
      index,
      crop: horizontal
        ? normalizeCrop({
            x: paddedStart / width,
            y: 0,
            width: (paddedEnd - paddedStart) / width,
            height: 1
          })
        : normalizeCrop({
            x: 0,
            y: paddedStart / height,
            width: 1,
            height: (paddedEnd - paddedStart) / height
          }),
      confidence,
      requiresConfirmation: confidence < 0.85
    };
  });
}

function estimateFilmBase(raw, crop = null) {
  const { data, width, height, channels = 3 } = raw || {};
  if (!data || !width || !height) throw new Error("片基采样图像数据不完整。");
  const normalized = normalizeCrop(crop || {});
  const left = Math.floor(normalized.x * width);
  const top = Math.floor(normalized.y * height);
  const right = Math.max(left + 1, Math.ceil((normalized.x + normalized.width) * width));
  const bottom = Math.max(top + 1, Math.ceil((normalized.y + normalized.height) * height));
  const border = Math.max(1, Math.round(Math.min(right - left, bottom - top) * 0.045));
  const samples = [[], [], []];
  const stride = Math.max(1, Math.round(Math.min(width, height) / 500));
  for (let y = top; y < bottom; y += stride) {
    for (let x = left; x < right; x += stride) {
      const isBorder =
        x < left + border ||
        x >= right - border ||
        y < top + border ||
        y >= bottom - border;
      if (!isBorder) continue;
      const offset = (y * width + x) * channels;
      for (let channel = 0; channel < 3; channel += 1) {
        samples[channel].push(
          Number(data[offset + Math.min(channel, channels - 1)]) / 255
        );
      }
    }
  }
  const rgb = samples.map((values) => quantile(values, 0.72));
  const spread = Math.max(...rgb) - Math.min(...rgb);
  const confidence = clamp(
    samples[0].length >= 48 ? 0.9 - Math.max(0, 0.08 - spread) : 0.55,
    0.4,
    0.96
  );
  return { rgb, confidence, sampleCount: samples[0].length };
}

function assessFilmFrameDynamicRange(raw, crop = null) {
  if (!raw?.data || !raw.width || !raw.height || !raw.channels) {
    return { eligible: false, effectiveStops: 0, tonalRange: 0, occupiedBins: 0 };
  }
  const normalizedCrop = normalizeCrop(crop || { x: 0, y: 0, width: 1, height: 1 });
  const left = Math.floor(normalizedCrop.x * raw.width);
  const top = Math.floor(normalizedCrop.y * raw.height);
  const right = Math.max(left + 1, Math.ceil((normalizedCrop.x + normalizedCrop.width) * raw.width));
  const bottom = Math.max(top + 1, Math.ceil((normalizedCrop.y + normalizedCrop.height) * raw.height));
  const pixelCount = Math.max(1, (right - left) * (bottom - top));
  const stride = Math.max(1, Math.floor(Math.sqrt(pixelCount / 65_536)));
  const luminance = [];
  const histogram = new Uint32Array(256);
  for (let y = top; y < bottom; y += stride) {
    for (let x = left; x < right; x += stride) {
      const offset = (y * raw.width + x) * raw.channels;
      const red = raw.data[offset] || 0;
      const green = raw.data[offset + Math.min(1, raw.channels - 1)] || red;
      const blue = raw.data[offset + Math.min(2, raw.channels - 1)] || green;
      const value = Math.max(
        0,
        Math.min(255, Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722))
      );
      luminance.push(value);
      histogram[value] += 1;
    }
  }
  const black = quantile(luminance, 0.005);
  const white = quantile(luminance, 0.995);
  const tonalRange = Math.max(0, white - black);
  const toLinear = (value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const effectiveStops = Math.log2(
    (toLinear(white) + 1 / 65_535) /
      Math.max(1 / 65_535, toLinear(black) + 1 / 65_535)
  );
  const occupiedBins = histogram.reduce(
    (count, occurrences) => count + (occurrences > 0 ? 1 : 0),
    0
  );
  return {
    eligible: tonalRange >= 150 && effectiveStops >= 6 && occupiedBins >= 96,
    effectiveStops,
    tonalRange,
    occupiedBins
  };
}

async function sampleFilmBaseAtPoint(filePath, point) {
  const sharp = loadSharp();
  const { data, info } = await sharp(filePath, {
    failOn: "error",
    limitInputPixels: 800_000_000,
    sequentialRead: true
  })
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  const centerX = Math.round(clamp(point?.x, 0, 1) * (info.width - 1));
  const centerY = Math.round(clamp(point?.y, 0, 1) * (info.height - 1));
  const totals = [0, 0, 0];
  const channels = Math.min(3, info.channels);
  let pixels = 0;
  for (let y = Math.max(0, centerY - 4); y <= Math.min(info.height - 1, centerY + 4); y += 1) {
    for (let x = Math.max(0, centerX - 4); x <= Math.min(info.width - 1, centerX + 4); x += 1) {
      const offset = (y * info.width + x) * info.channels;
      for (let channel = 0; channel < channels; channel += 1) {
        totals[channel] += data[offset + channel];
      }
      pixels += 1;
    }
  }
  if (channels === 1) totals[1] = totals[2] = totals[0];
  return totals.map((total) => Number((total / pixels / 255).toFixed(6)));
}

function demaskRgb(rgb, maskRgb, adjustments = {}) {
  const normalized = normalizeAdjustments({ ...adjustments, maskRgb });
  const mask = normalized.maskRgb || [0.8, 0.6, 0.4];
  return rgb.map((value, index) => {
    const channel = clamp(value, 0, 1);
    const black = normalized.blackPoint[index];
    const white = Math.max(black + 0.001, normalized.whitePoint[index]);
    const density = Math.max(0, -Math.log10(Math.max(channel, 1 / 65535)));
    const baseDensity = -Math.log10(Math.max(mask[index], 1 / 65535));
    const inverted = clamp((density - baseDensity) / 2.4, 0, 1);
    return clamp((inverted - black) / (white - black), 0, 1);
  });
}

function cropToPixels(crop, width, height) {
  const normalized = normalizeCrop(crop);
  const left = clamp(Math.round(normalized.x * width), 0, width - 1);
  const top = clamp(Math.round(normalized.y * height), 0, height - 1);
  const right = clamp(
    Math.round((normalized.x + normalized.width) * width),
    left + 1,
    width
  );
  const bottom = clamp(
    Math.round((normalized.y + normalized.height) * height),
    top + 1,
    height
  );
  return { left, top, width: right - left, height: bottom - top };
}

function loadSharp() {
  try {
    return require("sharp");
  } catch (error) {
    const wrapped = new Error(
      "胶片扫描处理需要 sharp/libvips；请先安装 API 依赖。"
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

async function inspectFilmScanSource(filePath) {
  const sharp = loadSharp();
  const image = sharp(filePath, {
    failOn: "error",
    limitInputPixels: 800_000_000,
    sequentialRead: true
  });
  const metadata = await image.metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) throw new Error("无法读取扫描文件尺寸。");
  if (width * height > 800_000_000) throw new Error("扫描文件超过 800 MP 限制。");
  return {
    width,
    height,
    pages: Number(metadata.pages || 1),
    format: metadata.format || null,
    bitDepth: metadata.depth === "ushort" ? 16 : metadata.depth === "uchar" ? 8 : null,
    depth: metadata.depth || null,
    space: metadata.space || null,
    channels: Number(metadata.channels || 0),
    hasIcc: Boolean(metadata.icc?.length),
    iccBytes: metadata.icc?.length || 0
  };
}

async function createAnalysisImage(filePath, maximumDimension = 2200) {
  const sharp = loadSharp();
  const result = await sharp(filePath, {
    failOn: "error",
    limitInputPixels: 800_000_000,
    sequentialRead: true
  })
    .rotate()
    .resize({
      width: maximumDimension,
      height: maximumDimension,
      fit: "inside",
      withoutEnlargement: true
    })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
    channels: result.info.channels
  };
}

async function renderFilmSourceContact(filePath, outputPath) {
  const sharp = loadSharp();
  return sharp(filePath, {
    failOn: "error",
    limitInputPixels: 800_000_000,
    sequentialRead: true
  })
    .rotate()
    .resize({
      width: 2200,
      height: 2200,
      fit: "inside",
      withoutEnlargement: true
    })
    .removeAlpha()
    .toColourspace("srgb")
    .jpeg({ quality: 82, chromaSubsampling: "4:4:4" })
    .toFile(outputPath);
}

function applyFilmPipeline(image, filmType, adjustments, maskRgb) {
  const normalized = normalizeAdjustments({ ...adjustments, maskRgb });
  let next = image;
  if (filmType === "color-negative") {
    const mask = normalized.maskRgb || [0.82, 0.62, 0.4];
    const scale = mask.map((channel) => 1 / Math.max(0.08, channel));
    next = next
      .linear([-1, -1, -1], mask.map((channel) => channel * 255))
      .linear(scale, [0, 0, 0]);
  } else if (filmType === "bw-negative") {
    next = next.greyscale().negate({ alpha: false });
  }

  const exposure = 2 ** normalized.exposure;
  const temperature = normalized.temperature;
  const tint = normalized.tint;
  const contrast = 1 + normalized.contrast * 0.8;
  const gains = [
    exposure * (1 + temperature * 0.16 + tint * 0.04) * contrast,
    exposure * (1 - tint * 0.09) * contrast,
    exposure * (1 - temperature * 0.16 + tint * 0.04) * contrast
  ];
  next = next.linear(gains, gains.map(() => 128 * (1 - contrast)));
  const rangeGains = normalized.whitePoint.map(
    (white, index) => 1 / Math.max(0.001, white - normalized.blackPoint[index])
  );
  next = next.linear(
    rangeGains,
    rangeGains.map(
      (gain, index) => -normalized.blackPoint[index] * 255 * gain
    )
  );
  if (normalized.saturation !== 0) {
    next = next.modulate({ saturation: Math.max(0, 1 + normalized.saturation) });
  }
  if (normalized.highlightRolloff > 0) {
    next = next
      .gamma(1, 1 + normalized.highlightRolloff * 0.65)
      .linear(1 + normalized.highlightRolloff * 0.08, 0);
  }
  return next;
}

async function renderFilmFrame(options) {
  const sharp = loadSharp();
  const metadata = await sharp(options.sourcePath, {
    failOn: "error",
    limitInputPixels: 800_000_000
  }).metadata();
  const extraction = cropToPixels(options.crop, metadata.width, metadata.height);
  let image = sharp(options.sourcePath, {
    failOn: "error",
    limitInputPixels: 800_000_000,
    sequentialRead: true
  })
    .extract(extraction)
    .rotate(Number(options.rotation || 0));
  image = applyFilmPipeline(
    image,
    options.filmType,
    options.adjustments,
    options.maskRgb
  );
  if (options.maximumDimension) {
    image = image.resize({
      width: options.maximumDimension,
      height: options.maximumDimension,
      fit: "inside",
      withoutEnlargement: true
    });
  }
  image = image.toColourspace("srgb");

  if (options.outputFormat === "tiff16") {
    return image
      .toColourspace("rgb16")
      .tiff({ compression: "deflate" })
      .toFile(options.outputPath);
  }
  if (options.outputFormat === "png16") {
    return image.png({ bitdepth: 16, compressionLevel: 8 }).toFile(options.outputPath);
  }
  return image
    .jpeg({ quality: options.quality || 92, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toFile(options.outputPath);
}

async function renderFilmRawFrame(options) {
  const sharp = loadSharp();
  const metadata = await sharp(options.sourcePath, {
    failOn: "error",
    limitInputPixels: 800_000_000
  }).metadata();
  const extraction = cropToPixels(options.crop, metadata.width, metadata.height);
  return sharp(options.sourcePath, {
    failOn: "error",
    limitInputPixels: 800_000_000,
    sequentialRead: true
  })
    .extract(extraction)
    .rotate(Number(options.rotation || 0))
    .toColourspace("srgb")
    .toColourspace("rgb16")
    .tiff({ compression: "deflate" })
    .toFile(options.outputPath);
}

async function sha256File(filePath) {
  const crypto = require("node:crypto");
  const handle = await fs.open(filePath, "r");
  const hash = crypto.createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

module.exports = {
  DEFAULT_ROLL_ADJUSTMENTS,
  FILM_FRAME_ASPECTS,
  FILM_SCAN_JOB_STATES,
  PROCESSES,
  SCANNERS,
  FILM_TYPES,
  applyFilmPipeline,
  assessFilmFrameDynamicRange,
  createAnalysisImage,
  cropToPixels,
  demaskRgb,
  detectFilmFrames,
  detectFilmScanSignature,
  estimateFilmBase,
  inspectFilmScanSource,
  mergeFrameAdjustments,
  normalizeAdjustments,
  normalizeCrop,
  normalizeFilmScanMetadata,
  renderFilmFrame,
  renderFilmRawFrame,
  renderFilmSourceContact,
  sampleFilmBaseAtPoint,
  sha256File,
  validateFilmScanUpload
};
