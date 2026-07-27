const path = require("node:path");

const SDR_IMAGE_MIME_EXTENSIONS = new Map([
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/png", new Set([".png"])],
  ["image/webp", new Set([".webp"])],
  ["image/avif", new Set([".avif"])]
]);

const HDR_IMAGE_MIME_EXTENSIONS = new Map([
  ["image/avif", new Set([".avif"])]
]);

function photoPairKey(filename) {
  const basename = path.basename(String(filename || "")).normalize("NFC");
  const extension = path.extname(basename);
  return normalizePhotoPairKey(
    extension ? basename.slice(0, -extension.length) : basename
  );
}

function normalizePhotoPairKey(value) {
  const stem = String(value || "")
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("en-US");
  if (!stem) {
    throw new Error("Photo filenames must include a non-empty basename.");
  }

  return stem;
}

function manifestPhotoPairKey(entry) {
  if (entry?.key !== undefined && entry?.key !== null) {
    return normalizePhotoPairKey(entry.key);
  }
  return photoPairKey(entry?.filename ?? entry?.name);
}

function pairAlbumFiles(sdrFiles, hdrFiles) {
  const sdrByKey = indexFiles(sdrFiles, "SDR");
  const hdrByKey = indexFiles(hdrFiles, "HDR");

  for (const key of hdrByKey.keys()) {
    if (!sdrByKey.has(key)) {
      throw new Error(`HDR photo "${key}" does not have a matching SDR photo.`);
    }
  }

  return [...sdrByKey].map(([key, sdr]) => ({
    key,
    sdr,
    hdr: hdrByKey.get(key) || null
  }));
}

function validateAlbumBatchLimits(sdrFiles, hdrFiles, limits) {
  const sdr = Array.isArray(sdrFiles) ? sdrFiles : [];
  const hdr = Array.isArray(hdrFiles) ? hdrFiles : [];
  const maxPhotos = Number(limits?.maxPhotos);
  const maxFileBytes = Number(limits?.maxFileBytes);
  const maxBatchBytes = Number(limits?.maxBatchBytes);

  if (Number.isFinite(maxPhotos) && (sdr.length > maxPhotos || hdr.length > maxPhotos)) {
    throw new Error(`At most ${maxPhotos} photos are allowed per batch.`);
  }

  let totalBytes = 0;
  for (const file of [...sdr, ...hdr]) {
    const size = Number(file?.size || 0);
    if (Number.isFinite(maxFileBytes) && size > maxFileBytes) {
      throw new Error(
        `Image ${file?.originalName || file?.filename || "upload"} exceeds ${maxFileBytes} bytes.`
      );
    }
    totalBytes += size;
  }

  if (Number.isFinite(maxBatchBytes) && totalBytes > maxBatchBytes) {
    throw new Error(`Album upload exceeds ${maxBatchBytes} bytes.`);
  }

  return { photoCount: sdr.length, fileCount: sdr.length + hdr.length, totalBytes };
}

async function rollbackAlbumBatch({
  photoIds = [],
  fileIds = [],
  deletePhoto,
  deleteFile
}) {
  const errors = [];

  for (const photoId of [...photoIds].reverse()) {
    try {
      await deletePhoto(photoId);
    } catch (error) {
      errors.push({ kind: "photo", id: photoId, error });
    }
  }
  for (const fileId of [...fileIds].reverse()) {
    try {
      await deleteFile(fileId);
    } catch (error) {
      errors.push({ kind: "file", id: fileId, error });
    }
  }

  return errors;
}

async function reconcileAlbumBatchResources({
  photoIds = [],
  fileIds = [],
  reconciliationTags = [],
  findFileByTag,
  findPhotosBySdrFiles
}) {
  const reconciledPhotoIds = new Set(photoIds.map(String));
  const reconciledFileIds = new Set(fileIds.filter(Boolean).map(String));
  const errors = [];

  const fileResults = await Promise.allSettled(
    reconciliationTags.map((tag) => findFileByTag(tag))
  );
  for (let index = 0; index < fileResults.length; index += 1) {
    const result = fileResults[index];
    if (result.status === "fulfilled") {
      if (result.value) {
        reconciledFileIds.add(String(result.value));
      }
    } else {
      errors.push({
        kind: "file-reconciliation",
        id: reconciliationTags[index],
        error: result.reason
      });
    }
  }

  try {
    const photos = await findPhotosBySdrFiles([...reconciledFileIds]);
    for (const photo of photos || []) {
      const id =
        photo && typeof photo === "object"
          ? photo.id
          : photo;
      if (id !== undefined && id !== null) {
        reconciledPhotoIds.add(String(id));
      }
    }
  } catch (error) {
    errors.push({
      kind: "photo-reconciliation",
      id: "batch",
      error
    });
  }

  return {
    photoIds: [...reconciledPhotoIds],
    fileIds: [...reconciledFileIds],
    errors
  };
}

function indexFiles(files, label) {
  const indexed = new Map();

  for (const file of files || []) {
    const name = file?.originalName || file?.filename || file?.name || "";
    const key = photoPairKey(name);
    if (indexed.has(key)) {
      throw new Error(`${label} photo basename "${key}" is duplicated.`);
    }
    indexed.set(key, file);
  }

  return indexed;
}

function validateImageMetadata(info, allowedMimeExtensions, label) {
  const mimeType = String(info?.mimeType || "").toLowerCase();
  const filename = String(info?.filename || "");
  const extension = path.extname(filename).toLowerCase();
  const allowedExtensions = allowedMimeExtensions.get(mimeType);

  if (!allowedExtensions || !allowedExtensions.has(extension)) {
    throw new Error(
      `Unsupported ${label} image ${filename || "upload"}.`
    );
  }
}

function detectImageMime(buffer) {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }

  const ascii = buffer.toString("ascii");
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "image/webp";
  }

  if (
    ascii.slice(4, 8) === "ftyp" &&
    /(?:avif|avis)/.test(ascii.slice(8))
  ) {
    return "image/avif";
  }

  return null;
}

function validateSdrProbe(probe) {
  const dimensions = probeDimensions(probe, "SDR");
  if (normalizeHdrTransfer(probe?.color_transfer)) {
    throw new Error("The SDR rendition contains an HDR transfer function.");
  }
  if (isAnimatedProbe(probe)) {
    throw new Error("Animated images are not supported in albums.");
  }

  return dimensions;
}

function validateHdrProbe(probe) {
  const dimensions = probeDimensions(probe, "HDR");
  const transfer = normalizeHdrTransfer(probe?.color_transfer);
  const bitDepth = inferProbeBitDepth(probe);

  if (String(probe?.codec_name || "").toLowerCase() !== "av1") {
    throw new Error("HDR photos must contain an AV1 image stream.");
  }
  if (!transfer) {
    throw new Error("HDR AVIF transfer must be PQ or HLG.");
  }
  if (![10, 12].includes(bitDepth)) {
    throw new Error("HDR AVIF must use 10-bit or 12-bit samples.");
  }
  if (isAnimatedProbe(probe)) {
    throw new Error("Animated HDR AVIF images are not supported.");
  }

  return {
    ...dimensions,
    transfer,
    primaries: stringOrNull(probe?.color_primaries),
    bitDepth
  };
}

function validatePairedAspectRatio(sdr, hdr, tolerance = 0.005) {
  const sdrRatio = sdr.width / sdr.height;
  const hdrRatio = hdr.width / hdr.height;
  const relativeDifference = Math.abs(sdrRatio - hdrRatio) / sdrRatio;

  if (!Number.isFinite(relativeDifference) || relativeDifference > tolerance) {
    throw new Error("Paired SDR and HDR photos must use the same aspect ratio.");
  }

  return true;
}

function probeDimensions(probe, label) {
  const width = Number(probe?.width);
  const height = Number(probe?.height);
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    throw new Error(`${label} photo dimensions could not be detected.`);
  }

  return { width, height };
}

function inferProbeBitDepth(probe) {
  const raw = Number.parseInt(probe?.bits_per_raw_sample, 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  const pixelFormat = String(probe?.pix_fmt || "").toLowerCase();
  const match = pixelFormat.match(/(?:p|le|be)(10|12|16)/);
  return match ? Number(match[1]) : 8;
}

function normalizeHdrTransfer(value) {
  const transfer = String(value || "").trim().toLowerCase();
  if (["smpte2084", "smpte-st-2084", "pq"].includes(transfer)) {
    return "pq";
  }
  if (["arib-std-b67", "hlg"].includes(transfer)) {
    return "hlg";
  }
  return null;
}

function isAnimatedProbe(probe) {
  const declaredFrameCount = Number.parseInt(probe?.nb_frames, 10);
  const readFrameCount = Number.parseInt(probe?.nb_read_frames, 10);
  return (
    (Number.isFinite(declaredFrameCount) && declaredFrameCount > 1) ||
    (Number.isFinite(readFrameCount) && readFrameCount > 1)
  );
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

module.exports = {
  HDR_IMAGE_MIME_EXTENSIONS,
  SDR_IMAGE_MIME_EXTENSIONS,
  detectImageMime,
  inferProbeBitDepth,
  manifestPhotoPairKey,
  normalizeHdrTransfer,
  normalizePhotoPairKey,
  pairAlbumFiles,
  photoPairKey,
  reconcileAlbumBatchResources,
  rollbackAlbumBatch,
  validateAlbumBatchLimits,
  validateHdrProbe,
  validateImageMetadata,
  validatePairedAspectRatio,
  validateSdrProbe
};
