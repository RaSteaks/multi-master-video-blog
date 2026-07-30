const Busboy = require("busboy");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const {
  HDR_IMAGE_MIME_EXTENSIONS,
  SDR_IMAGE_MIME_EXTENSIONS,
  detectImageMime,
  manifestPhotoPairKey,
  pairAlbumFiles,
  reconcileAlbumBatchResources,
  rollbackAlbumBatch,
  validateAlbumBatchLimits,
  validateHdrProbe,
  validateImageMetadata,
  validatePairedAspectRatio,
  validateSdrProbe
} = require("./album-utils.cjs");
const {
  FILM_SCAN_JOB_STATES,
  assessFilmFrameDynamicRange,
  createAnalysisImage,
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
  sha256File: sha256FilmScanFile,
  validateFilmScanUpload
} = require("./film-scan-utils.cjs");
const { createDirectusTokenCache } = require("./directus-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "..", "..");
const env = loadEnv(path.join(ROOT, ".env"));

const HOST = env.HOST || "127.0.0.1";
const PORT = Number(env.PORT || 8060);
const DIRECTUS_URL = stripTrailingSlash(env.DIRECTUS_URL || "http://127.0.0.1:8055");
const DIRECTUS_EMAIL = env.DIRECTUS_EMAIL || "admin@example.com";
const DIRECTUS_PASSWORD = env.DIRECTUS_PASSWORD || "change-this-local-password";
const UPLOAD_API_TOKEN_PLACEHOLDER = "__REPLACE_WITH_RANDOM_UPLOAD_TOKEN__";
const configuredUploadApiToken = String(env.UPLOAD_API_TOKEN || "").trim();
const UPLOAD_API_TOKEN =
  configuredUploadApiToken === UPLOAD_API_TOKEN_PLACEHOLDER
    ? ""
    : configuredUploadApiToken;
const ARTICLE_API_TOKEN_PLACEHOLDER = "__REPLACE_WITH_RANDOM_ARTICLE_TOKEN__";
const configuredArticleApiToken = String(env.ARTICLE_API_TOKEN || "").trim();
const ARTICLE_API_TOKEN =
  configuredArticleApiToken === ARTICLE_API_TOKEN_PLACEHOLDER
    ? ""
    : configuredArticleApiToken || UPLOAD_API_TOKEN;
const MEDIA_ROOT = path.resolve(ROOT, env.MEDIA_ROOT || "../../media");
const MAX_UPLOAD_BYTES = Number(env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_ARTICLE_UPLOAD_BYTES = positiveInteger(
  env.MAX_ARTICLE_UPLOAD_BYTES,
  64 * 1024 * 1024
);
const MAX_ARTICLE_IMAGE_BYTES = positiveInteger(
  env.MAX_ARTICLE_IMAGE_BYTES,
  12 * 1024 * 1024
);
const MAX_ARTICLE_MARKDOWN_BYTES = positiveInteger(
  env.MAX_ARTICLE_MARKDOWN_BYTES,
  2 * 1024 * 1024
);
const MAX_ARTICLE_IMAGES = positiveInteger(env.MAX_ARTICLE_IMAGES, 24);
const MAX_ALBUM_UPLOAD_BYTES = positiveInteger(
  env.MAX_ALBUM_UPLOAD_BYTES,
  512 * 1024 * 1024
);
const MAX_ALBUM_IMAGE_BYTES = positiveInteger(
  env.MAX_ALBUM_IMAGE_BYTES,
  64 * 1024 * 1024
);
const MAX_ALBUM_PHOTOS = positiveInteger(env.MAX_ALBUM_PHOTOS, 24);
const MAX_FILM_SCAN_SOURCE_BYTES = positiveInteger(
  env.MAX_FILM_SCAN_SOURCE_BYTES,
  2 * 1024 * 1024 * 1024
);
const MAX_FILM_SCAN_JOB_BYTES = positiveInteger(
  env.MAX_FILM_SCAN_JOB_BYTES,
  4 * 1024 * 1024 * 1024
);
const MAX_FILM_SCAN_SOURCES = positiveInteger(env.MAX_FILM_SCAN_SOURCES, 48);
const FILM_SCAN_PROCESS_TIMEOUT_MS = positiveInteger(
  env.FILM_SCAN_PROCESS_TIMEOUT_MS,
  30 * 60 * 1000
);
const FILM_SCAN_ROOT = path.join(MEDIA_ROOT, "film-scans");
const FFMPEG_PATH = env.FFMPEG_PATH || resolveOptionalPackage("ffmpeg-static") || "ffmpeg";
const FFPROBE_PATH =
  env.FFPROBE_PATH || resolveOptionalPackage("ffprobe-static", "path") || "ffprobe";

const MASTER_TYPES = new Set(["sdr", "hdr10", "hlg", "dolby_vision", "custom"]);
const SOURCE_KINDS = new Set(["embedded", "master_package", "hls_package"]);
const TRANSCODE_TYPES = new Set(["sdr", "hdr10", "hlg", "custom"]);
const HDR_MASTER_TYPES = new Set(["hdr10", "hlg", "dolby_vision"]);
const ANALYTICS_ITEM_TYPES = new Set(["post", "video"]);
const ANALYTICS_EVENT_TYPES = new Set(["view", "play"]);
const ARTICLE_IMAGE_MIME_EXTENSIONS = new Map([
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/png", new Set([".png"])],
  ["image/webp", new Set([".webp"])],
  ["image/gif", new Set([".gif"])],
  ["image/avif", new Set([".avif"])]
]);
const ARTICLE_IMAGE_PREFIX = "article-image://";
const ARTICLE_IMAGE_TARGET_PATTERN =
  /!\[([^\]\r\n]*)\]\(article-image:\/\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\)/g;
const ALBUM_ASSET_PRESETS = new Set(["album-cover", "album-thumb"]);
const COLOR_REQUIRED_FIELDS = [
  "colorPrimaries",
  "colorTransfer",
  "matrixCoefficients",
  "colorRange",
  "pixelFormat",
  "bitDepth",
  "chromaLocation"
];

function loadEnv(filePath) {
  const values = { ...process.env };

  if (!fs.existsSync(filePath)) {
    return values;
  }

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values[key] = value;
  }

  return values;
}

function resolveOptionalPackage(packageName, property) {
  try {
    const resolved = require(packageName);
    return property ? resolved[property] : resolved;
  } catch {
    return null;
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/$/, "");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function requireUploadAuth(req) {
  if (!UPLOAD_API_TOKEN) {
    throw httpError(503, "Video uploading is disabled until UPLOAD_API_TOKEN is configured.");
  }

  const authorization = req.headers.authorization || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const uploadToken = req.headers["x-upload-token"] || "";

  if (bearer === UPLOAD_API_TOKEN || uploadToken === UPLOAD_API_TOKEN) {
    return;
  }

  throw httpError(401, "Missing or invalid upload API token.");
}

function tokenMatches(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));

  return (
    actualBuffer.length === expectedBuffer.length &&
    actualBuffer.length > 0 &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function requireArticleAuth(req) {
  if (!ARTICLE_API_TOKEN) {
    throw httpError(503, "Article publishing is disabled until ARTICLE_API_TOKEN is configured.");
  }

  const authorization = String(req.headers.authorization || "");
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  const bearer = bearerMatch ? bearerMatch[1].trim() : "";
  const articleToken = String(req.headers["x-article-token"] || "").trim();
  const compatibleUploadToken = String(req.headers["x-upload-token"] || "").trim();

  if (
    tokenMatches(bearer, ARTICLE_API_TOKEN) ||
    tokenMatches(articleToken, ARTICLE_API_TOKEN) ||
    tokenMatches(compatibleUploadToken, ARTICLE_API_TOKEN)
  ) {
    return;
  }

  throw httpError(401, "Missing or invalid article API token.");
}

function requireAlbumAuth(req) {
  if (!UPLOAD_API_TOKEN) {
    throw httpError(
      503,
      "Album management is disabled until UPLOAD_API_TOKEN is configured."
    );
  }

  const authorization = String(req.headers.authorization || "");
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  const bearer = bearerMatch ? bearerMatch[1].trim() : "";
  const uploadToken = String(req.headers["x-upload-token"] || "").trim();

  if (
    tokenMatches(bearer, UPLOAD_API_TOKEN) ||
    tokenMatches(uploadToken, UPLOAD_API_TOKEN)
  ) {
    return;
  }

  throw httpError(401, "Missing or invalid album management token.");
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDecimal(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNullableInteger(value) {
  const parsed = parseInteger(value);
  return parsed === undefined ? null : parsed;
}

function parseTags(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function validateSlug(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw httpError(400, "slug must use lowercase letters, numbers, and hyphens only.");
  }
}

function safeFileName(filename) {
  const parsed = path.parse(filename || "upload.bin");
  const name = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload";
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]+/g, "") || ".bin";
  return `${name}${ext}`;
}

function safePathSegment(value, fallback = "item") {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

function safeRelativePath(filename) {
  const rawParts = String(filename || "upload.bin").split(/[\\/]+/);
  const parts = rawParts
    .map((part) => safeFileName(part))
    .filter((part) => part && part !== "." && part !== "..");

  return parts.length ? path.join(...parts) : "upload.bin";
}

function assertInside(parent, target) {
  const relative = path.relative(parent, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(400, "Resolved file path is outside the media root.");
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason || httpError(499, "Processing was canceled."));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      cleanup();
      reject(options.signal?.reason || httpError(499, "Processing was canceled."));
    };
    const timeout =
      Number(options.timeoutMs) > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            cleanup();
            reject(
              httpError(
                504,
                `${path.basename(command)} exceeded the processing timeout.`
              )
            );
          }, Number(options.timeoutMs))
        : null;
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`${command} exited with code ${code}: ${stderr || stdout}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function commandAvailable(command) {
  try {
    await runProcess(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function parseMultipart(req) {
  const uploadId = crypto.randomUUID();
  const tempDir = path.join(ROOT, "tmp", uploadId);
  await fsp.mkdir(tempDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const fields = {};
    const pendingWrites = [];
    let fileInfo = null;
    let uploadBytes = 0;
    let rejected = false;

    const files = {};
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 500,
        fields: 64,
        fileSize: MAX_UPLOAD_BYTES
      }
    });

    function rejectOnce(error) {
      if (rejected) {
        return;
      }

      rejected = true;
      req.unpipe(busboy);
      busboy.removeAllListeners();
      fsp.rm(tempDir, { recursive: true, force: true }).finally(() => reject(error));
    }

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (name, file, info) => {
      if (!["video", "cover", "masterPackage"].includes(name)) {
        file.resume();
        return;
      }

      const filename = name === "masterPackage" ? safeRelativePath(info.filename) : safeFileName(info.filename);
      const tempPath = path.join(tempDir, name === "masterPackage" ? filename : safeFileName(filename));
      assertInside(tempDir, tempPath);
      fs.mkdirSync(path.dirname(tempPath), { recursive: true });
      const writeStream = fs.createWriteStream(tempPath);

      const currentFile = {
        field: name,
        filename,
        mimeType: info.mimeType,
        tempPath,
        tempDir
      };

      if (name === "masterPackage") {
        files.masterPackage = files.masterPackage || [];
        files.masterPackage.push(currentFile);
      } else {
        files[name] = currentFile;
      }

      if (name === "video") {
        fileInfo = currentFile;
      }

      file.on("data", (chunk) => {
        uploadBytes += chunk.length;
      });

      file.on("limit", () => {
        rejectOnce(httpError(413, `Upload exceeds MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES}.`));
      });

      file.on("error", rejectOnce);
      writeStream.on("error", rejectOnce);

      pendingWrites.push(
        new Promise((resolveWrite, rejectWrite) => {
          writeStream.on("finish", resolveWrite);
          writeStream.on("error", rejectWrite);
        })
      );

      file.pipe(writeStream);
    });

    busboy.on("error", rejectOnce);
    busboy.on("finish", async () => {
      if (rejected) {
        return;
      }

      try {
        await Promise.all(pendingWrites);

        resolve({
          fields,
          files,
          tempDir,
          file: fileInfo
            ? {
                ...fileInfo,
                size: uploadBytes
              }
            : null
        });
      } catch (error) {
        rejectOnce(error);
      }
    });

    req.pipe(busboy);
  });
}

async function parseArticleMultipart(req) {
  const contentTypeHeader = String(req.headers["content-type"] || "");
  if (!contentTypeHeader.toLowerCase().startsWith("multipart/form-data")) {
    throw httpError(415, "Article requests must use multipart/form-data.");
  }

  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTICLE_UPLOAD_BYTES) {
    throw httpError(413, `Article upload exceeds ${MAX_ARTICLE_UPLOAD_BYTES} bytes.`);
  }

  const tempDir = path.join(ROOT, "tmp", `article-${crypto.randomUUID()}`);
  await fsp.mkdir(tempDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const fields = Object.create(null);
    const files = { cover: null, inlineImages: [] };
    const pendingWrites = [];
    const activeWrites = new Set();
    let fileSequence = 0;
    let requestBytes = 0;
    let settled = false;
    let busboy;

    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          files: MAX_ARTICLE_IMAGES + 1,
          fields: 16,
          fileSize: MAX_ARTICLE_IMAGE_BYTES,
          fieldSize: MAX_ARTICLE_MARKDOWN_BYTES,
          parts: MAX_ARTICLE_IMAGES + 17
        }
      });
    } catch (error) {
      fsp.rm(tempDir, { recursive: true, force: true }).finally(() => {
        reject(httpError(400, `Invalid multipart request: ${error.message}`));
      });
      return;
    }

    const removeRequestListeners = () => {
      req.off("data", onRequestData);
      req.off("aborted", onRequestAborted);
    };

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      req.unpipe(busboy);
      removeRequestListeners();
      for (const writeStream of activeWrites) {
        writeStream.destroy(error);
      }
      if (!req.complete) {
        req.resume();
      }

      Promise.allSettled(pendingWrites)
        .then(() => fsp.rm(tempDir, { recursive: true, force: true }))
        .finally(() => reject(error));
    };

    function onRequestData(chunk) {
      requestBytes += chunk.length;
      if (requestBytes > MAX_ARTICLE_UPLOAD_BYTES) {
        rejectOnce(httpError(413, `Article upload exceeds ${MAX_ARTICLE_UPLOAD_BYTES} bytes.`));
      }
    }

    function onRequestAborted() {
      rejectOnce(httpError(400, "Article upload was interrupted."));
    }

    busboy.on("field", (name, value, info) => {
      if (info.valueTruncated) {
        rejectOnce(httpError(413, `Article field ${name} is too large.`));
        return;
      }

      if (
        [
          "title",
          "slug",
          "content",
          "category",
          "tags",
          "published",
          "inlineImageManifest",
          "articleId",
          "removeCover"
        ].includes(name)
      ) {
        fields[name] = value;
      }
    });

    busboy.on("file", (name, file, info) => {
      if (settled) {
        file.resume();
        return;
      }

      if (name !== "cover" && name !== "inlineImages") {
        file.resume();
        return;
      }

      if (name === "cover" && files.cover) {
        file.resume();
        rejectOnce(httpError(400, "Only one cover image is allowed."));
        return;
      }

      if (name === "inlineImages" && files.inlineImages.length >= MAX_ARTICLE_IMAGES) {
        file.resume();
        rejectOnce(httpError(413, `At most ${MAX_ARTICLE_IMAGES} inline images are allowed.`));
        return;
      }

      try {
        validateArticleImageMetadata(info);
      } catch (error) {
        file.resume();
        rejectOnce(error);
        return;
      }

      fileSequence += 1;
      const originalName = path.basename(String(info.filename || "image"));
      const filename = safeFileName(originalName);
      const tempPath = path.join(tempDir, `${fileSequence}-${filename}`);
      assertInside(tempDir, tempPath);
      const writeStream = fs.createWriteStream(tempPath);
      activeWrites.add(writeStream);

      const currentFile = {
        field: name,
        filename,
        originalName,
        mimeType: String(info.mimeType || "").toLowerCase(),
        tempPath,
        tempDir,
        size: 0
      };

      if (name === "cover") {
        files.cover = currentFile;
      } else {
        files.inlineImages.push(currentFile);
      }

      file.on("data", (chunk) => {
        currentFile.size += chunk.length;
      });
      file.on("limit", () => {
        rejectOnce(httpError(413, `Image ${originalName} exceeds ${MAX_ARTICLE_IMAGE_BYTES} bytes.`));
      });
      file.on("error", rejectOnce);
      writeStream.on("error", rejectOnce);
      writeStream.on("close", () => activeWrites.delete(writeStream));

      pendingWrites.push(
        new Promise((resolveWrite, rejectWrite) => {
          writeStream.on("finish", resolveWrite);
          writeStream.on("error", rejectWrite);
        })
      );

      file.pipe(writeStream);
    });

    busboy.on("filesLimit", () => {
      rejectOnce(httpError(413, `At most ${MAX_ARTICLE_IMAGES} inline images and one cover are allowed.`));
    });
    busboy.on("fieldsLimit", () => rejectOnce(httpError(413, "Too many article fields.")));
    busboy.on("partsLimit", () => rejectOnce(httpError(413, "Too many multipart parts.")));
    busboy.on("error", (error) => {
      rejectOnce(httpError(400, `Invalid multipart request: ${error.message}`));
    });
    busboy.on("finish", async () => {
      if (settled) {
        return;
      }

      try {
        await Promise.all(pendingWrites);
        const articleFiles = [files.cover, ...files.inlineImages].filter(Boolean);
        await Promise.all(articleFiles.map(assertArticleImageContents));
        settled = true;
        removeRequestListeners();
        resolve({ fields, files, tempDir });
      } catch (error) {
        rejectOnce(error);
      }
    });

    req.on("data", onRequestData);
    req.once("aborted", onRequestAborted);
    req.pipe(busboy);
  });
}

function validateArticleImageMetadata(info) {
  const mimeType = String(info.mimeType || "").toLowerCase();
  const extension = path.extname(String(info.filename || "")).toLowerCase();
  const allowedExtensions = ARTICLE_IMAGE_MIME_EXTENSIONS.get(mimeType);

  if (!allowedExtensions || !allowedExtensions.has(extension)) {
    throw httpError(
      415,
      `Unsupported article image ${info.filename || "upload"}. Use JPEG, PNG, WebP, GIF, or AVIF.`
    );
  }
}

async function assertArticleImageContents(file) {
  if (!file.size) {
    throw httpError(400, `Image ${file.originalName} is empty.`);
  }

  const handle = await fsp.open(file.tempPath, "r");
  const signature = Buffer.alloc(64);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(signature, 0, signature.length, 0));
  } finally {
    await handle.close();
  }

  const detectedMimeType = detectArticleImageMime(signature.subarray(0, bytesRead));
  if (detectedMimeType !== file.mimeType) {
    throw httpError(415, `Image ${file.originalName} does not match its declared MIME type.`);
  }
}

function detectArticleImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }

  const ascii = buffer.toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (ascii.slice(4, 8) === "ftyp" && /(?:avif|avis)/.test(ascii.slice(8))) {
    return "image/avif";
  }

  return null;
}

async function parseFilmScanMultipart(req) {
  const contentTypeHeader = String(req.headers["content-type"] || "");
  if (!contentTypeHeader.toLowerCase().startsWith("multipart/form-data")) {
    throw httpError(415, "胶片扫描导入必须使用 multipart/form-data。");
  }
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILM_SCAN_JOB_BYTES) {
    throw httpError(413, "单个胶片扫描任务不能超过 4 GiB。");
  }

  await fsp.mkdir(path.join(ROOT, "tmp"), { recursive: true });
  const tempDir = path.join(ROOT, "tmp", `film-scan-${crypto.randomUUID()}`);
  await fsp.mkdir(tempDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const fields = Object.create(null);
    const files = [];
    const pendingWrites = [];
    const activeWrites = new Set();
    let requestBytes = 0;
    let fileSequence = 0;
    let settled = false;
    let busboy;

    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      if (busboy) req.unpipe(busboy);
      for (const stream of activeWrites) stream.destroy(error);
      if (!req.complete) req.resume();
      Promise.allSettled(pendingWrites)
        .then(() => fsp.rm(tempDir, { recursive: true, force: true }))
        .finally(() => reject(error));
    };

    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          files: MAX_FILM_SCAN_SOURCES,
          fields: 2,
          fileSize: MAX_FILM_SCAN_SOURCE_BYTES,
          fieldSize: 1024 * 1024,
          parts: MAX_FILM_SCAN_SOURCES + 2
        }
      });
    } catch (error) {
      finishWithError(httpError(400, `无效的胶片扫描上传请求：${error.message}`));
      return;
    }

    req.on("data", (chunk) => {
      requestBytes += chunk.length;
      if (requestBytes > MAX_FILM_SCAN_JOB_BYTES) {
        finishWithError(httpError(413, "单个胶片扫描任务不能超过 4 GiB。"));
      }
    });
    req.once("aborted", () => {
      finishWithError(httpError(400, "胶片扫描上传已中断。"));
    });

    busboy.on("field", (name, value, info) => {
      if (info.valueTruncated) {
        finishWithError(httpError(413, `字段 ${name} 过大。`));
        return;
      }
      if (name === "metadata") fields.metadata = value;
    });

    busboy.on("file", (name, file, info) => {
      if (settled) {
        file.resume();
        return;
      }
      if (name !== "sources") {
        file.resume();
        return;
      }
      fileSequence += 1;
      const originalName = path.basename(String(info.filename || "scan.tif"));
      const filename = `${String(fileSequence).padStart(3, "0")}-${safeFileName(originalName)}`;
      const tempPath = path.join(tempDir, filename);
      assertInside(tempDir, tempPath);
      const writeStream = fs.createWriteStream(tempPath, { flags: "wx" });
      activeWrites.add(writeStream);
      const current = {
        filename,
        originalName,
        mimeType: String(info.mimeType || "application/octet-stream").toLowerCase(),
        tempPath,
        tempDir,
        size: 0,
        truncated: false
      };
      files.push(current);
      file.on("data", (chunk) => {
        current.size += chunk.length;
      });
      file.on("limit", () => {
        current.truncated = true;
        finishWithError(
          httpError(413, `原档“${originalName}”超过单文件 2 GiB 限制。`)
        );
      });
      const writePromise = new Promise((resolveWrite, rejectWrite) => {
        writeStream.on("finish", resolveWrite);
        writeStream.on("error", rejectWrite);
      }).finally(() => activeWrites.delete(writeStream));
      pendingWrites.push(writePromise);
      file.pipe(writeStream);
    });

    busboy.on("filesLimit", () =>
      finishWithError(httpError(413, `单任务最多上传 ${MAX_FILM_SCAN_SOURCES} 个原档。`))
    );
    busboy.on("fieldsLimit", () =>
      finishWithError(httpError(413, "胶片扫描字段过多。"))
    );
    busboy.on("partsLimit", () =>
      finishWithError(httpError(413, "胶片扫描 multipart 部件过多。"))
    );
    busboy.on("error", (error) =>
      finishWithError(httpError(400, `无效的胶片扫描上传请求：${error.message}`))
    );
    busboy.on("finish", async () => {
      if (settled) return;
      try {
        await Promise.all(pendingWrites);
        if (!files.length) throw httpError(400, "请至少上传一个胶片扫描原档。");
        if (!fields.metadata) throw httpError(400, "metadata 字段不能为空。");
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > MAX_FILM_SCAN_JOB_BYTES) {
          throw httpError(413, "单个胶片扫描任务不能超过 4 GiB。");
        }
        const stat = await fsp.statfs(MEDIA_ROOT).catch(() => null);
        if (stat) {
          const available = Number(stat.bavail) * Number(stat.bsize);
          const reserve = Math.max(2 * 1024 * 1024 * 1024, totalBytes);
          if (available < totalBytes + reserve) {
            throw httpError(507, "媒体磁盘余量不足，无法安全保留原档。");
          }
        }
        for (const file of files) {
          const handle = await fsp.open(file.tempPath, "r");
          const signatureBuffer = Buffer.alloc(64);
          let bytesRead;
          try {
            ({ bytesRead } = await handle.read(signatureBuffer, 0, 64, 0));
          } finally {
            await handle.close();
          }
          const signature = detectFilmScanSignature(
            signatureBuffer.subarray(0, bytesRead)
          );
          try {
            Object.assign(
              file,
              validateFilmScanUpload({
                filename: file.originalName,
                declaredMime: file.mimeType,
                signature
              })
            );
          } catch (error) {
            throw httpError(415, `原档“${file.originalName}”：${error.message}`);
          }
          file.sha256 = await sha256FilmScanFile(file.tempPath);
        }
        const duplicate = files.find(
          (file, index) => files.findIndex((candidate) => candidate.sha256 === file.sha256) !== index
        );
        if (duplicate) {
          throw httpError(409, `原档“${duplicate.originalName}”在本任务中重复。`);
        }
        settled = true;
        resolve({ fields, files, tempDir, totalBytes });
      } catch (error) {
        finishWithError(error);
      }
    });

    req.pipe(busboy);
  });
}

async function parseAlbumMultipart(req) {
  const contentTypeHeader = String(req.headers["content-type"] || "");
  if (!contentTypeHeader.toLowerCase().startsWith("multipart/form-data")) {
    throw httpError(415, "Album photo uploads must use multipart/form-data.");
  }

  const declaredLength = Number(req.headers["content-length"] || 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_ALBUM_UPLOAD_BYTES
  ) {
    throw httpError(
      413,
      `Album upload exceeds ${MAX_ALBUM_UPLOAD_BYTES} bytes.`
    );
  }

  const tempDir = path.join(ROOT, "tmp", `album-${crypto.randomUUID()}`);
  await fsp.mkdir(tempDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const fields = Object.create(null);
    const files = { sdrFiles: [], hdrFiles: [] };
    const pendingWrites = [];
    const activeWrites = new Set();
    let fileSequence = 0;
    let requestBytes = 0;
    let settled = false;
    let busboy;

    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          files: MAX_ALBUM_PHOTOS * 2,
          fields: 2,
          fileSize: MAX_ALBUM_IMAGE_BYTES,
          fieldSize: 512 * 1024,
          parts: MAX_ALBUM_PHOTOS * 2 + 2
        }
      });
    } catch (error) {
      fsp.rm(tempDir, { recursive: true, force: true }).finally(() => {
        reject(httpError(400, `Invalid multipart request: ${error.message}`));
      });
      return;
    }

    const removeRequestListeners = () => {
      req.off("data", onRequestData);
      req.off("aborted", onRequestAborted);
    };

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      req.unpipe(busboy);
      removeRequestListeners();
      for (const writeStream of activeWrites) {
        writeStream.destroy(error);
      }
      if (!req.complete) {
        req.resume();
      }

      Promise.allSettled(pendingWrites)
        .then(() => fsp.rm(tempDir, { recursive: true, force: true }))
        .finally(() => reject(error));
    };

    function onRequestData(chunk) {
      requestBytes += chunk.length;
      if (requestBytes > MAX_ALBUM_UPLOAD_BYTES) {
        rejectOnce(
          httpError(
            413,
            `Album upload exceeds ${MAX_ALBUM_UPLOAD_BYTES} bytes.`
          )
        );
      }
    }

    function onRequestAborted() {
      rejectOnce(httpError(400, "Album photo upload was interrupted."));
    }

    busboy.on("field", (name, value, info) => {
      if (info.valueTruncated) {
        rejectOnce(httpError(413, `Album field ${name} is too large.`));
        return;
      }
      if (name === "manifest") {
        fields.manifest = value;
      }
    });

    busboy.on("file", (name, file, info) => {
      if (settled) {
        file.resume();
        return;
      }

      if (name !== "sdrFiles" && name !== "hdrFiles") {
        file.resume();
        return;
      }

      const targetFiles = files[name];
      if (targetFiles.length >= MAX_ALBUM_PHOTOS) {
        file.resume();
        rejectOnce(
          httpError(
            413,
            `At most ${MAX_ALBUM_PHOTOS} ${name === "sdrFiles" ? "SDR" : "HDR"} photos are allowed.`
          )
        );
        return;
      }

      try {
        validateImageMetadata(
          info,
          name === "sdrFiles"
            ? SDR_IMAGE_MIME_EXTENSIONS
            : HDR_IMAGE_MIME_EXTENSIONS,
          name === "sdrFiles" ? "SDR" : "HDR"
        );
      } catch (error) {
        file.resume();
        rejectOnce(httpError(415, error.message));
        return;
      }

      fileSequence += 1;
      const originalName = path.basename(String(info.filename || "image"));
      const filename = safeFileName(originalName);
      const tempPath = path.join(tempDir, `${fileSequence}-${filename}`);
      assertInside(tempDir, tempPath);
      const writeStream = fs.createWriteStream(tempPath);
      activeWrites.add(writeStream);

      const currentFile = {
        field: name,
        filename,
        originalName,
        mimeType: String(info.mimeType || "").toLowerCase(),
        tempPath,
        tempDir,
        size: 0
      };
      targetFiles.push(currentFile);

      file.on("data", (chunk) => {
        currentFile.size += chunk.length;
      });
      file.on("limit", () => {
        rejectOnce(
          httpError(
            413,
            `Image ${originalName} exceeds ${MAX_ALBUM_IMAGE_BYTES} bytes.`
          )
        );
      });
      file.on("error", rejectOnce);
      writeStream.on("error", rejectOnce);
      writeStream.on("close", () => activeWrites.delete(writeStream));

      pendingWrites.push(
        new Promise((resolveWrite, rejectWrite) => {
          writeStream.on("finish", resolveWrite);
          writeStream.on("error", rejectWrite);
        })
      );

      file.pipe(writeStream);
    });

    busboy.on("filesLimit", () => {
      rejectOnce(
        httpError(
          413,
          `At most ${MAX_ALBUM_PHOTOS} SDR/HDR photo pairs are allowed.`
        )
      );
    });
    busboy.on("fieldsLimit", () =>
      rejectOnce(httpError(413, "Too many album upload fields."))
    );
    busboy.on("partsLimit", () =>
      rejectOnce(httpError(413, "Too many album upload parts."))
    );
    busboy.on("error", (error) => {
      rejectOnce(httpError(400, `Invalid multipart request: ${error.message}`));
    });
    busboy.on("finish", async () => {
      if (settled) {
        return;
      }

      try {
        await Promise.all(pendingWrites);
        await Promise.all(
          [...files.sdrFiles, ...files.hdrFiles].map(assertAlbumImageContents)
        );
        settled = true;
        removeRequestListeners();
        resolve({ fields, files, tempDir });
      } catch (error) {
        rejectOnce(error);
      }
    });

    req.on("data", onRequestData);
    req.once("aborted", onRequestAborted);
    req.pipe(busboy);
  });
}

async function assertAlbumImageContents(file) {
  if (!file.size) {
    throw httpError(400, `Image ${file.originalName} is empty.`);
  }

  const handle = await fsp.open(file.tempPath, "r");
  const signature = Buffer.alloc(64);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(signature, 0, signature.length, 0));
  } finally {
    await handle.close();
  }

  const detectedMimeType = detectImageMime(
    signature.subarray(0, bytesRead)
  );
  if (detectedMimeType !== file.mimeType) {
    throw httpError(
      415,
      `Image ${file.originalName} does not match its declared MIME type.`
    );
  }
}

function normalizeArticleUpload(fields, files) {
  const title = String(fields.title || "").trim();
  const slug = String(fields.slug || "").trim();
  const content = String(fields.content || "");
  const category = String(fields.category || "").trim() || null;
  const published = parseArticlePublished(fields.published);
  const articleId = parseArticleId(fields.articleId);
  const removeCover = parseArticleFlag(fields.removeCover, "removeCover");

  if (!title) {
    throw httpError(400, "title is required.");
  }
  if (title.length > 200) {
    throw httpError(400, "title must be 200 characters or fewer.");
  }
  if (!slug) {
    throw httpError(400, "slug is required.");
  }
  if (slug.length > 200) {
    throw httpError(400, "slug must be 200 characters or fewer.");
  }
  validateSlug(slug);
  if (Buffer.byteLength(content, "utf8") > MAX_ARTICLE_MARKDOWN_BYTES) {
    throw httpError(413, `Markdown exceeds ${MAX_ARTICLE_MARKDOWN_BYTES} bytes.`);
  }
  if (published && !content.trim()) {
    throw httpError(400, "content is required when publishing an article.");
  }
  if (category && category.length > 100) {
    throw httpError(400, "category must be 100 characters or fewer.");
  }
  if (files.cover && removeCover) {
    throw httpError(400, "cover and removeCover cannot be submitted together.");
  }

  const tags = parseArticleTags(fields.tags);
  const inlineImages = normalizeInlineImageManifest(
    fields.inlineImageManifest,
    files.inlineImages,
    content
  );

  return {
    title,
    slug,
    content,
    category,
    tags,
    published,
    articleId,
    removeCover,
    cover: files.cover,
    inlineImages
  };
}

function parseArticleId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = String(value).trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw httpError(400, "articleId must be a positive integer.");
  }

  const articleId = Number(normalized);
  if (!Number.isSafeInteger(articleId)) {
    throw httpError(400, "articleId is outside the supported range.");
  }

  return articleId;
}

function parseArticleFlag(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw httpError(400, `${fieldName} must be true or false.`);
}

function parseArticlePublished(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "published"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "draft"].includes(normalized)) {
    return false;
  }

  throw httpError(400, "published must be true or false.");
}

function parseArticleTags(value) {
  if (!value) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw httpError(400, "tags must be a JSON array of strings.");
  }

  if (!Array.isArray(parsed)) {
    throw httpError(400, "tags must be a JSON array of strings.");
  }
  if (parsed.length > 30) {
    throw httpError(400, "At most 30 tags are allowed.");
  }

  const tags = [];
  const seen = new Set();
  for (const valueItem of parsed) {
    if (typeof valueItem !== "string") {
      throw httpError(400, "Every tag must be a string.");
    }
    const tag = valueItem.trim();
    if (!tag) {
      continue;
    }
    if (tag.length > 64) {
      throw httpError(400, "Each tag must be 64 characters or fewer.");
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }

  return tags;
}

function normalizeInlineImageManifest(rawManifest, inlineFiles, content) {
  let manifest = [];
  if (rawManifest) {
    try {
      manifest = JSON.parse(rawManifest);
    } catch {
      throw httpError(400, "inlineImageManifest must be valid JSON.");
    }
  }

  if (!Array.isArray(manifest)) {
    throw httpError(400, "inlineImageManifest must be a JSON array.");
  }
  if (manifest.length !== inlineFiles.length) {
    throw httpError(400, "inlineImageManifest must contain one entry per inlineImages file.");
  }

  const normalized = [];
  const manifestKeys = new Set();
  for (const [index, item] of manifest.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw httpError(400, `inlineImageManifest entry ${index + 1} is invalid.`);
    }

    const key = String(item.key || "").trim();
    const name = String(item.name || inlineFiles[index].originalName).trim();
    const alt = String(item.alt || "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)) {
      throw httpError(400, `inline image key ${key || index + 1} is invalid.`);
    }
    if (manifestKeys.has(key)) {
      throw httpError(400, `inline image key ${key} is duplicated.`);
    }
    if (name.length > 255 || alt.length > 300) {
      throw httpError(400, `inline image metadata for ${key} is too long.`);
    }

    manifestKeys.add(key);
    normalized.push({ key, name, alt, file: inlineFiles[index] });
  }

  const targets = markdownArticleImageTargets(content);
  const referencedKeys = new Set();
  for (const target of targets) {
    referencedKeys.add(target.key);
    if (!manifestKeys.has(target.key)) {
      throw httpError(400, `Markdown references unknown inline image key ${target.key}.`);
    }
  }

  const codeRanges = markdownCodeRanges(content);
  let placeholderIndex = content.indexOf(ARTICLE_IMAGE_PREFIX);
  const validTargetStarts = new Set(targets.map((target) => target.targetStart));
  while (placeholderIndex !== -1) {
    if (
      !indexIsInRanges(placeholderIndex, codeRanges) &&
      !validTargetStarts.has(placeholderIndex)
    ) {
      throw httpError(
        400,
        "article-image placeholders are only allowed as generated Markdown image targets."
      );
    }
    placeholderIndex = content.indexOf(
      ARTICLE_IMAGE_PREFIX,
      placeholderIndex + ARTICLE_IMAGE_PREFIX.length
    );
  }

  for (const key of manifestKeys) {
    if (!referencedKeys.has(key)) {
      throw httpError(400, `Inline image ${key} is not referenced by the Markdown content.`);
    }
  }

  return normalized;
}

function replaceInlineImagePlaceholders(content, uploadedImages) {
  const imageUrls = new Map(uploadedImages.map((image) => [image.key, image.url]));
  const targets = markdownArticleImageTargets(content);
  let replaced = content;

  for (const target of [...targets].reverse()) {
    const imageUrl = imageUrls.get(target.key);
    if (!imageUrl) {
      throw httpError(400, `Inline image ${target.key} could not be resolved.`);
    }
    replaced =
      replaced.slice(0, target.targetStart) + imageUrl + replaced.slice(target.targetEnd);
  }

  return replaced;
}

function markdownArticleImageTargets(markdown) {
  const codeRanges = markdownCodeRanges(markdown);
  const targets = [];
  const pattern = new RegExp(ARTICLE_IMAGE_TARGET_PATTERN.source, "g");
  let match;

  while ((match = pattern.exec(markdown))) {
    if (indexIsInRanges(match.index, codeRanges)) {
      continue;
    }

    const relativeTargetStart = match[0].indexOf(ARTICLE_IMAGE_PREFIX);
    const targetStart = match.index + relativeTargetStart;
    targets.push({
      key: match[2],
      targetStart,
      targetEnd: targetStart + ARTICLE_IMAGE_PREFIX.length + match[2].length
    });
  }

  return targets;
}

function markdownCodeRanges(markdown) {
  const ranges = [];
  const linePattern = /.*(?:\r\n|\n|\r|$)/g;
  let fence = null;
  let fenceStart = 0;
  let lineMatch;

  while ((lineMatch = linePattern.exec(markdown))) {
    const rawLine = lineMatch[0];
    if (!rawLine) {
      break;
    }

    const lineStart = lineMatch.index;
    const lineEnd = lineStart + rawLine.length;
    const line = rawLine.replace(/[\r\n]+$/, "");

    if (fence) {
      const closePattern = new RegExp(
        `^ {0,3}${fence.character}{${fence.length},}[\\t ]*$`
      );
      if (closePattern.test(line)) {
        ranges.push([fenceStart, lineEnd]);
        fence = null;
      }
      continue;
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (openingFence) {
      fence = {
        character: openingFence[1][0],
        length: openingFence[1].length
      };
      fenceStart = lineStart;
      continue;
    }

    const backtickRuns = Array.from(line.matchAll(/`+/g));
    let runIndex = 0;
    while (runIndex < backtickRuns.length) {
      const openingRun = backtickRuns[runIndex];
      let closingIndex = runIndex + 1;
      while (
        closingIndex < backtickRuns.length &&
        backtickRuns[closingIndex][0].length !== openingRun[0].length
      ) {
        closingIndex += 1;
      }

      if (closingIndex < backtickRuns.length) {
        const closingRun = backtickRuns[closingIndex];
        ranges.push([
          lineStart + openingRun.index,
          lineStart + closingRun.index + closingRun[0].length
        ]);
        runIndex = closingIndex + 1;
      } else {
        runIndex += 1;
      }
    }
  }

  if (fence) {
    ranges.push([fenceStart, markdown.length]);
  }

  return ranges;
}

function indexIsInRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function normalizeUpload(fields) {
  const title = String(fields.title || "").trim();
  const slug = String(fields.slug || "").trim();
  const masterType = String(fields.masterType || fields.type || "sdr").trim();
  const sourceKind = String(fields.sourceKind || fields.source_kind || "embedded").trim();

  if (!title) {
    throw httpError(400, "title is required.");
  }

  if (!slug) {
    throw httpError(400, "slug is required.");
  }

  validateSlug(slug);

  if (!MASTER_TYPES.has(masterType)) {
    throw httpError(400, `masterType must be one of: ${Array.from(MASTER_TYPES).join(", ")}.`);
  }

  if (!SOURCE_KINDS.has(sourceKind)) {
    throw httpError(400, `sourceKind must be one of: ${Array.from(SOURCE_KINDS).join(", ")}.`);
  }

  const mode = fields.mode === "transcode" ? "transcode" : "copy";
  if (!["copy", "transcode"].includes(mode)) {
    throw httpError(400, "mode must be copy or transcode.");
  }

  return {
    title,
    slug,
    description: fields.description || "",
    category: fields.category || null,
    tags: parseTags(fields.tags),
    published: parseBoolean(fields.published, false),
    sourceKind,
    masterType,
    label: fields.label || defaultLabel(masterType),
    isDefault: parseBoolean(fields.isDefault, masterType === "sdr"),
    overwrite: parseBoolean(fields.overwrite, false),
    mode,
    processingMode: mode,
    isDerivative: parseBoolean(fields.isDerivative || fields.is_derivative, false),
    derivedFromMasterId: parseNullableInteger(
      fields.derivedFromMasterId || fields.derived_from_master_id
    ),
    conversionIntent: fields.conversionIntent || fields.conversion_intent || null,
    conversionLutOrFilter:
      fields.conversionLutOrFilter || fields.conversion_lut_or_filter || null,
    codec: fields.codec || null,
    colorSpace: fields.colorSpace || fields.color_space || null,
    transferFunction:
      fields.transferFunction || fields.transfer_function || null,
    bitDepth: parseInteger(fields.bitDepth || fields.bit_depth),
    resolutionWidth: parseInteger(fields.resolutionWidth || fields.resolution_width),
    resolutionHeight: parseInteger(fields.resolutionHeight || fields.resolution_height),
    bitrateMbps: parseDecimal(fields.bitrateMbps || fields.bitrate_mbps),
    notes: fields.notes || null
  };
}

function defaultLabel(masterType) {
  return {
    sdr: "SDR",
    hdr10: "HDR10",
    hlg: "HLG",
    dolby_vision: "Dolby Vision",
    custom: "Custom"
  }[masterType];
}

function defaultCodec(masterType, mode) {
  if (mode === "copy" || masterType !== "sdr") {
    return "HEVC / H.265";
  }

  return "H.264 / AVC";
}

function defaultColorSpace(masterType) {
  return masterType === "sdr" ? "BT.709" : "BT.2020";
}

function defaultTransferFunction(masterType) {
  if (masterType === "hlg") {
    return "HLG";
  }

  return masterType === "sdr" ? "BT.709" : "PQ / ST2084";
}

function defaultBitDepth(masterType) {
  return masterType === "sdr" ? 8 : 10;
}

async function moveSourceFile(file, metadata) {
  if (!file) {
    throw httpError(400, "Missing source video file.");
  }

  const sourceDir = path.join(MEDIA_ROOT, metadata.slug, "source");
  const sourcePath = path.join(sourceDir, `${Date.now()}-${file.filename}`);

  assertInside(MEDIA_ROOT, sourceDir);
  assertInside(MEDIA_ROOT, sourcePath);

  await fsp.mkdir(sourceDir, { recursive: true });
  await fsp.rename(file.tempPath, sourcePath);

  return sourcePath;
}

async function moveMasterPackageFiles(files, metadata) {
  if (!files?.length) {
    throw httpError(400, "Missing Dolby Vision master package files.");
  }

  const packageDir = path.join(MEDIA_ROOT, metadata.slug, "source-package");
  assertInside(MEDIA_ROOT, packageDir);

  if (fs.existsSync(packageDir) && metadata.overwrite) {
    await fsp.rm(packageDir, { recursive: true, force: true });
  }

  await fsp.mkdir(packageDir, { recursive: true });

  const movedFiles = [];
  for (const file of files) {
    const relative = safeRelativePath(file.filename);
    const targetPath = path.join(packageDir, relative);
    assertInside(packageDir, targetPath);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.rename(file.tempPath, targetPath);
    movedFiles.push({
      ...file,
      packagePath: targetPath,
      packageRelativePath: relative
    });
  }

  const primary =
    metadata.sourceKind === "hls_package"
      ? selectHlsPackagePrimary(movedFiles)
      : selectMasterPackagePrimary(movedFiles);
  if (!primary) {
    throw httpError(
      400,
      metadata.sourceKind === "hls_package"
        ? "No HLS playlist was found in the package. Include a master.m3u8 multivariant playlist."
        : "No primary video essence was found in the master package. Include MP4, MOV, MXF, MKV, HEVC, H265, or 265 files."
    );
  }

  return {
    sourcePath: primary.packagePath,
    packageDir,
    files: movedFiles,
    sidecars: movedFiles.filter((file) => isDolbySidecar(file.packagePath))
  };
}

function selectMasterPackagePrimary(files) {
  const priorities = [".mp4", ".mov", ".mkv", ".hevc", ".h265", ".265", ".mxf"];
  return [...files]
    .filter((file) => priorities.includes(path.extname(file.packagePath).toLowerCase()))
    .sort((a, b) => {
      const scoreA = masterPackagePrimaryScore(a, priorities);
      const scoreB = masterPackagePrimaryScore(b, priorities);
      if (scoreA !== scoreB) {
        return scoreA - scoreB;
      }

      return a.packageRelativePath.localeCompare(b.packageRelativePath);
    })[0];
}

function selectHlsPackagePrimary(files) {
  const playlists = [...files]
    .filter((file) => path.extname(file.packagePath).toLowerCase() === ".m3u8")
    .sort((a, b) => hlsPlaylistScore(a) - hlsPlaylistScore(b));

  return playlists[0] || null;
}

function hlsPlaylistScore(file) {
  const relative = file.packageRelativePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(relative);
  let score = relative.split("/").length * 20;

  if (basename === "master.m3u8") {
    score -= 100;
  }

  if (basename.includes("media") || basename.includes("stream")) {
    score -= 20;
  }

  return score;
}

function masterPackagePrimaryScore(file, priorities) {
  const ext = path.extname(file.packagePath).toLowerCase();
  const basename = path.basename(file.packagePath).toLowerCase();
  let score = priorities.indexOf(ext) * 100;

  if (ext === ".mxf") {
    if (basename.startsWith("video_") || basename.includes("mainimage")) {
      score -= 40;
    }

    if (basename.startsWith("audio_") || basename.includes("audio")) {
      score += 80;
    }

    if (basename.startsWith("dolby_") || basename.includes("isxd")) {
      score += 120;
    }
  }

  return score;
}

function isDolbySidecar(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  return (
    [".xml", ".json", ".txt", ".rpu", ".bin"].includes(ext) ||
    (ext === ".mxf" && (basename.startsWith("dolby_") || basename.includes("isxd")))
  );
}

async function prepareOutputDir(metadata) {
  const typeSegment = metadata.masterType.replace("_", "-");
  const labelSegment = safePathSegment(metadata.label || defaultLabel(metadata.masterType), "master");
  const versionSegment = `${Date.now()}-${labelSegment}`;
  const outputDir = path.join(MEDIA_ROOT, metadata.slug, typeSegment, versionSegment);
  assertInside(MEDIA_ROOT, outputDir);

  if (fs.existsSync(outputDir)) {
    const entries = await fsp.readdir(outputDir);
    if (entries.length > 0) {
      throw httpError(409, `HLS output directory already exists and is not empty: ${outputDir}`);
    }
  }

  await fsp.mkdir(outputDir, { recursive: true });
  return outputDir;
}

async function probeVideo(sourcePath) {
  const { stdout } = await runProcess(FFPROBE_PATH, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_streams",
    "-of",
    "json",
    sourcePath
  ]);

  const parsed = JSON.parse(stdout);
  return parsed.streams?.[0] || {};
}

async function generateHls(sourcePath, outputDir, metadata, probe = {}) {
  const masterPlaylistPath = path.join(outputDir, "master.m3u8");
  const mediaPlaylistPath = path.join(outputDir, "media.m3u8");

  if (metadata.mode === "copy") {
    const args = [
      "-y",
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "copy"
    ];

    if (isHevcCodec(probe.codec_name)) {
      args.push("-tag:v", "hvc1");
    }

    args.push(
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-strict",
      "unofficial",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_time",
      "4",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      path.join(outputDir, "segment_%03d.m4s"),
      mediaPlaylistPath
    );

    await runProcess(FFMPEG_PATH, args, { cwd: outputDir });
    return {
      masterPlaylistPath,
      mediaPlaylistPath
    };
  }

  if (HDR_MASTER_TYPES.has(metadata.masterType)) {
    throw httpError(
      422,
      `${metadata.masterType} masters must use mode=copy. Create HDR/SDR compatibility versions as separate derivative masters with an explicit conversion pipeline.`
    );
  }

  const args = [
    "-y",
    "-i",
    sourcePath,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-color_range",
    "tv",
    "-force_key_frames",
    "expr:gte(t,n_forced*4)",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-hls_time",
    "4",
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    path.join(outputDir, "segment_%03d.ts"),
    mediaPlaylistPath
  ];

  if (TRANSCODE_TYPES.has(metadata.masterType)) {
    await runProcess(FFMPEG_PATH, args);
    return {
      masterPlaylistPath,
      mediaPlaylistPath
    };
  }

  throw httpError(400, `Unsupported transcode masterType: ${metadata.masterType}`);
}

function shouldCreatePreviewHls(metadata, probe) {
  return (
    metadata.sourceKind === "master_package" &&
    metadata.masterType === "dolby_vision" &&
    !isHevcCodec(probe.codec_name)
  );
}

function isHevcCodec(codecName) {
  const value = String(codecName || "").toLowerCase();
  return value === "hevc" || value === "h265";
}

async function generatePreviewHls(sourcePath, outputDir, playlistPath) {
  await runProcess(FFMPEG_PATH, [
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    "expr:gte(t,n_forced*4)",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-hls_time",
    "4",
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    path.join(outputDir, "segment_%03d.ts"),
    playlistPath
  ]);
  await stampHlsPlaylist(playlistPath);
}

async function prepareHlsPackageOutput(packageInfo, outputDir) {
  const sourceRoot = packageInfo.packageDir;
  const sourcePlaylistPath = packageInfo.sourcePath;
  const sourceRelative = path.relative(sourceRoot, sourcePlaylistPath);
  await fsp.cp(sourceRoot, outputDir, { recursive: true });

  const copiedSourcePlaylistPath = path.join(outputDir, sourceRelative);
  assertInside(outputDir, copiedSourcePlaylistPath);

  const mediaPlaylistPath = await primaryMediaPlaylistPath(copiedSourcePlaylistPath, outputDir);
  const masterPlaylistPath = path.join(outputDir, "master.m3u8");
  const variants = await copiedHlsVariants(copiedSourcePlaylistPath, outputDir);

  if (path.resolve(mediaPlaylistPath) === path.resolve(masterPlaylistPath)) {
    const fallbackMediaPath = path.join(outputDir, "media.m3u8");
    await fsp.copyFile(mediaPlaylistPath, fallbackMediaPath);
    return {
      masterPlaylistPath,
      mediaPlaylistPath: fallbackMediaPath,
      variants
    };
  }

  return {
    masterPlaylistPath,
    mediaPlaylistPath,
    variants
  };
}

async function copiedHlsVariants(masterPlaylistPath, outputDir) {
  const text = await fsp.readFile(masterPlaylistPath, "utf8");
  return parseStreamInfoVariants(text).map((variant) => {
    if (!variant.uri) {
      return null;
    }

    const absoluteVariantPath = path.resolve(path.dirname(masterPlaylistPath), stripUriQuery(variant.uri));
    assertInside(outputDir, absoluteVariantPath);
    return {
      attributes: variant.attributes,
      uri: path.relative(outputDir, absoluteVariantPath).replace(/\\/g, "/")
    };
  }).filter(Boolean);
}

async function primaryMediaPlaylistPath(playlistPath, rootDir) {
  const text = await fsp.readFile(playlistPath, "utf8");
  const variantUris = parseVariantUris(text);
  if (!variantUris.length) {
    return playlistPath;
  }

  const variantPath = path.resolve(path.dirname(playlistPath), stripUriQuery(variantUris[0]));
  assertInside(rootDir, variantPath);
  return variantPath;
}

function parseVariantUris(playlistText) {
  const lines = playlistText.split(/\r?\n/);
  const uris = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) {
      continue;
    }

    const uri = lines
      .slice(index + 1)
      .find((line) => line.trim() && !line.trim().startsWith("#"));
    if (uri) {
      uris.push(uri.trim());
    }
  }

  return uris;
}

function parseStreamInfoVariants(playlistText) {
  const lines = playlistText.split(/\r?\n/);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) {
      continue;
    }

    const uri = lines
      .slice(index + 1)
      .find((candidate) => candidate.trim() && !candidate.trim().startsWith("#"));
    variants.push({
      attributes: parseHlsAttributeList(line.slice("#EXT-X-STREAM-INF:".length)),
      uri: uri ? uri.trim() : null
    });
  }

  return variants;
}

function parseHlsAttributeList(text) {
  const attributes = {};
  let current = "";
  let quoted = false;
  const parts = [];

  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
    }

    if (char === "," && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim().toUpperCase();
    const value = part.slice(separator + 1).trim().replace(/^"|"$/g, "");
    attributes[key] = value;
  }

  return attributes;
}

function stripUriQuery(uri) {
  return uri.split("?")[0].split("#")[0];
}

function normalizeHlsVideoRange(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return ["SDR", "PQ", "HLG"].includes(text) ? text : null;
}

async function inspectHlsPackage(packageInfo, metadata, sidecar = {}) {
  const playlistPath = packageInfo.sourcePath;
  const playlistText = await fsp.readFile(playlistPath, "utf8");
  const variants = parseStreamInfoVariants(playlistText);

  if (!variants.length) {
    throwColorContractError([
      "hls_package: master.m3u8 must be a multivariant playlist with EXT-X-STREAM-INF and VIDEO-RANGE."
    ]);
  }

  const inspected = [];
  const errors = [];

  for (const variant of variants) {
    if (!variant.uri) {
      errors.push("hls_package: EXT-X-STREAM-INF is missing its media playlist URI.");
      continue;
    }

    const videoRange = normalizeHlsVideoRange(variant.attributes["VIDEO-RANGE"]);
    if (!videoRange) {
      errors.push(`hls_package: ${variant.uri} is missing VIDEO-RANGE.`);
    }

    const variantPath = path.resolve(path.dirname(playlistPath), stripUriQuery(variant.uri));
    assertInside(packageInfo.packageDir, variantPath);
    const probe = await probeVideo(variantPath);
    const contract = buildColorContract(probe, metadata, sidecar, {
      hlsVideoRange: videoRange
    });
    errors.push(...validateColorContract(metadata, contract, `hls_package ${variant.uri}`));
    inspected.push({
      uri: variant.uri,
      path: variantPath,
      attributes: variant.attributes,
      probe,
      contract
    });
  }

  const primary = inspected[0];
  if (!primary) {
    errors.push("hls_package: no probeable media playlist was found.");
  }

  if (primary) {
    for (const item of inspected.slice(1)) {
      errors.push(
        ...compareHlsVariantContracts(primary.contract, item.contract).map(
          (message) => `hls_package ${item.uri}: ${message}`
        )
      );
    }
  }

  if (errors.length) {
    throwColorContractError(errors);
  }

  return {
    playlistPath,
    primaryMediaPlaylistPath: primary.path,
    probe: primary.probe,
    contract: primary.contract,
    variants: inspected.map((item) => ({
      uri: item.uri,
      videoRange: item.contract.hlsVideoRange,
      colorPrimaries: item.contract.colorPrimaries,
      colorTransfer: item.contract.colorTransfer,
      matrixCoefficients: item.contract.matrixCoefficients,
      colorRange: item.contract.colorRange,
      bitDepth: item.contract.bitDepth,
      displayGamut: item.contract.displayGamut
    }))
  };
}

function compareHlsVariantContracts(base, next) {
  const fields = [
    "bitDepth",
    "colorPrimaries",
    "displayGamut",
    "colorTransfer",
    "matrixCoefficients",
    "colorRange",
    "hlsVideoRange"
  ];
  const errors = [];

  for (const field of fields) {
    if ((base[field] ?? null) !== (next[field] ?? null)) {
      errors.push(`${field} differs across HLS variants.`);
    }
  }

  return errors;
}

async function stampHlsPlaylist(playlistPath) {
  const version = Date.now();
  const text = await fsp.readFile(playlistPath, "utf8");
  const stamped = text
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("#EXT-X-MAP:")) {
        return line.replace(/URI="([^"?]+)"/, `URI="$1?v=${version}"`);
      }

      if (!line.startsWith("#") && /\.(?:ts|m4s)$/.test(line)) {
        return `${line}?v=${version}`;
      }

      return line;
    })
    .join("\n");

  await fsp.writeFile(playlistPath, stamped);
}

async function finalizeHlsOutput(output, metadata, sourceContract, sidecar = {}, sourceProbe = {}) {
  const outputProbe = await probeVideo(output.mediaPlaylistPath);
  const outputContract = buildColorContract(outputProbe, metadata, sidecar, {
    hlsVideoRange: sourceContract.hlsVideoRange
  });
  const errors = [
    ...validateColorContract(metadata, outputContract, "output"),
    ...compareColorContracts(sourceContract, outputContract)
  ];

  if (errors.length) {
    throwColorContractError(errors);
  }

  await writeMultivariantPlaylist(output.masterPlaylistPath, output.mediaPlaylistPath, outputContract, outputProbe, output.variants);
  await stampHlsPlaylist(output.mediaPlaylistPath);
  await stampHlsPlaylist(output.masterPlaylistPath);

  const verification = {
    status: "ready",
    errors: [],
    verifiedAt: new Date().toISOString(),
    sourceProbeSummary: summarizeProbe(sourceProbe),
    outputProbeSummary: summarizeProbe(outputProbe)
  };
  await writeVerificationReport(path.dirname(output.masterPlaylistPath), {
    verification,
    sourceContract,
    outputContract
  });

  return {
    playlistPath: output.masterPlaylistPath,
    outputProbe,
    outputContract,
    verification
  };
}

async function writeMultivariantPlaylist(masterPlaylistPath, mediaPlaylistPath, contract, probe, variants = []) {
  if (variants.length) {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
    for (const variant of variants) {
      const attributes = {
        ...variant.attributes,
        "VIDEO-RANGE": contract.hlsVideoRange || variant.attributes["VIDEO-RANGE"]
      };
      lines.push(`#EXT-X-STREAM-INF:${serializeHlsAttributeList(attributes)}`);
      lines.push(variant.uri);
    }
    lines.push("");
    await fsp.writeFile(masterPlaylistPath, lines.join("\n"), "utf8");
    return;
  }

  const relativeMediaUri = path.relative(path.dirname(masterPlaylistPath), mediaPlaylistPath).replace(/\\/g, "/");
  const bandwidth = Number(probe.bit_rate || contract.bitRate || 8000000);
  const attributes = [
    `BANDWIDTH=${Math.max(Math.round(bandwidth), 1)}`,
    `AVERAGE-BANDWIDTH=${Math.max(Math.round(bandwidth), 1)}`,
    contract.width && contract.height ? `RESOLUTION=${contract.width}x${contract.height}` : null,
    contract.hlsVideoRange ? `VIDEO-RANGE=${contract.hlsVideoRange}` : null,
    `CODECS="${codecStringFromProbe(probe, contract)}"`
  ].filter(Boolean);

  const text = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-STREAM-INF:${attributes.join(",")}`,
    relativeMediaUri,
    ""
  ].join("\n");

  await fsp.writeFile(masterPlaylistPath, text, "utf8");
}

function serializeHlsAttributeList(attributes) {
  return Object.entries(attributes)
    .map(([key, value]) => {
      if (value === null || value === undefined || value === "") {
        return null;
      }

      const needsQuotes = /[,"]/.test(String(value)) || key === "CODECS";
      const escaped = String(value).replace(/"/g, '\\"');
      return `${key}=${needsQuotes ? `"${escaped}"` : escaped}`;
    })
    .filter(Boolean)
    .join(",");
}

function codecStringFromProbe(probe, contract) {
  const codec = String(probe.codec_name || contract.codecName || "").toLowerCase();

  if (codec === "hevc" || codec === "h265") {
    return "hvc1.1.6.L93.B0,mp4a.40.2";
  }

  if (codec === "h264") {
    return "avc1.640028,mp4a.40.2";
  }

  if (codec === "av1") {
    return "av01.0.08M.10,mp4a.40.2";
  }

  return `${codec || "mp4v"}.unknown,mp4a.40.2`;
}

async function writeVerificationReport(outputDir, report) {
  await fsp.writeFile(
    path.join(outputDir, "color-verification.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
}

function summarizeProbe(probe) {
  return {
    codec_name: probe.codec_name || null,
    pix_fmt: probe.pix_fmt || null,
    color_primaries: probe.color_primaries || null,
    color_transfer: probe.color_transfer || null,
    color_space: probe.color_space || null,
    color_range: probe.color_range || null,
    chroma_location: probe.chroma_location || null,
    width: probe.width || null,
    height: probe.height || null,
    bits_per_raw_sample: probe.bits_per_raw_sample || null
  };
}

function mediaUrlFromPath(filePath) {
  assertInside(MEDIA_ROOT, filePath);
  const relative = path.relative(MEDIA_ROOT, filePath).replace(/\\/g, "/");
  return `/media/${relative}`;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function extractDolbyVisionMetadata(probe) {
  const sideDataList = Array.isArray(probe.side_data_list) ? probe.side_data_list : [];
  const dovi = sideDataList.find((item) =>
    String(item.side_data_type || "").toLowerCase().includes("dovi")
  );

  if (!dovi) {
    return {};
  }

  return {
    profile: firstDefined(dovi.dv_profile, dovi.profile),
    level: firstDefined(dovi.dv_level, dovi.level),
    compatibilityId: firstDefined(
      dovi.dv_bl_signal_compatibility_id,
      dovi.bl_signal_compatibility_id,
      dovi.compatibility_id
    ),
    rpuPresent: firstDefined(dovi.rpu_present_flag, dovi.rpu_present),
    elPresent: firstDefined(dovi.el_present_flag, dovi.el_present),
    blPresent: firstDefined(dovi.bl_present_flag, dovi.bl_present)
  };
}

function extractHdrStaticMetadata(probe) {
  const sideDataList = Array.isArray(probe.side_data_list) ? probe.side_data_list : [];
  const masteringDisplay = sideDataList.find((item) =>
    String(item.side_data_type || "").toLowerCase().includes("mastering display")
  );
  const contentLightLevel = sideDataList.find((item) =>
    String(item.side_data_type || "").toLowerCase().includes("content light")
  );

  return {
    masteringDisplay: masteringDisplay || null,
    contentLightLevel: contentLightLevel || null,
    masteringDisplayPresent: Boolean(masteringDisplay),
    contentLightLevelPresent: Boolean(contentLightLevel)
  };
}

function normalizeColorToken(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || ["unknown", "unspecified", "reserved", "n/a", "na"].includes(text)) {
    return null;
  }

  return text.replace(/[^a-z0-9]+/g, "");
}

function normalizePrimaries(value) {
  const token = normalizeColorToken(value);
  if (!token) {
    return { code: null, displayGamut: null, label: null };
  }

  if (token === "bt709" || token === "bt470bg" || token === "smpte170m") {
    return { code: "bt709", displayGamut: "bt709", label: "BT.709" };
  }

  if (token === "bt2020" || token === "bt2020cl" || token === "bt2020nc") {
    return { code: "bt2020", displayGamut: "bt2020", label: "BT.2020" };
  }

  if (token === "smpte432" || token === "p3d65" || token === "displayp3") {
    return { code: "smpte432", displayGamut: "p3_d65", label: "P3-D65(smpte432)" };
  }

  if (token === "smpte431" || token === "dcip3") {
    return { code: "smpte431", displayGamut: "dci_p3", label: "DCI-P3(smpte431)" };
  }

  return { code: token, displayGamut: "custom", label: value ? String(value) : "Custom" };
}

function normalizeTransfer(value) {
  const token = normalizeColorToken(value);
  if (!token) {
    return { code: null, label: null, hlsVideoRange: null };
  }

  if (token === "smpte2084" || token === "pq" || token === "st2084") {
    return { code: "smpte2084", label: "PQ / ST2084", hlsVideoRange: "PQ" };
  }

  if (token === "aribstdb67" || token === "hlg") {
    return { code: "arib-std-b67", label: "HLG", hlsVideoRange: "HLG" };
  }

  if (token === "bt709" || token === "bt470m" || token === "smpte170m") {
    return { code: "bt709", label: "BT.709", hlsVideoRange: "SDR" };
  }

  return { code: token, label: value ? String(value) : "Custom", hlsVideoRange: null };
}

function normalizeMatrix(value) {
  const token = normalizeColorToken(value);
  if (!token) {
    return null;
  }

  if (token === "bt2020nc" || token === "bt2020ncl") {
    return "bt2020nc";
  }

  if (token === "bt2020cl") {
    return "bt2020cl";
  }

  if (token === "bt709") {
    return "bt709";
  }

  if (token === "smpte170m" || token === "bt470bg") {
    return "smpte170m";
  }

  return token;
}

function normalizeRange(value) {
  const token = normalizeColorToken(value);
  if (!token) {
    return null;
  }

  if (token === "tv" || token === "mpeg" || token === "limited") {
    return "limited";
  }

  if (token === "pc" || token === "jpeg" || token === "full") {
    return "full";
  }

  return token;
}

function expectedVideoRange(metadata, contract = null) {
  if (metadata.masterType === "hdr10") {
    return "PQ";
  }

  if (metadata.masterType === "hlg") {
    return "HLG";
  }

  if (metadata.masterType === "sdr") {
    return "SDR";
  }

  return contract?.transferVideoRange || null;
}

function buildColorContract(probe, metadata, sidecar = {}, options = {}) {
  const primaries = normalizePrimaries(probe.color_primaries);
  const transfer = normalizeTransfer(probe.color_transfer);
  const hdrStaticMetadata = extractHdrStaticMetadata(probe);
  const dovi = extractDolbyVisionMetadata(probe);
  const dolbyCompatibilityId = sidecar.compatibilityId || stringOrNull(dovi.compatibilityId);
  const dolbyProfile = normalizeDolbyProfileVersion(
    sidecar.profile || stringOrNull(dovi.profile),
    dolbyCompatibilityId
  );
  const bitDepth = inferBitDepth(probe, metadata.masterType);
  const hlsVideoRange =
    normalizeHlsVideoRange(options.hlsVideoRange) ||
    expectedVideoRange(metadata, { transferVideoRange: transfer.hlsVideoRange });

  return {
    codecName: stringOrNull(probe.codec_name),
    codecProfile: stringOrNull(probe.profile),
    width: probe.width || null,
    height: probe.height || null,
    bitRate: probe.bit_rate ? Number(probe.bit_rate) : null,
    pixelFormat: stringOrNull(probe.pix_fmt),
    bitDepth,
    colorPrimaries: primaries.code,
    colorPrimariesLabel: primaries.label,
    displayGamut: primaries.displayGamut,
    displayGamutLabel: primaries.label,
    colorTransfer: transfer.code,
    transferFunctionLabel: transfer.label,
    transferVideoRange: transfer.hlsVideoRange,
    matrixCoefficients: normalizeMatrix(probe.color_space),
    colorRange: normalizeRange(probe.color_range),
    chromaLocation: stringOrNull(probe.chroma_location),
    hlsVideoRange,
    hdrStaticMetadata,
    dolbyMetadata: {
      profile: dolbyProfile,
      level: sidecar.level || stringOrNull(dovi.level),
      compatibilityId: dolbyCompatibilityId,
      rpuPresent: booleanOrFalse(dovi.rpuPresent),
      elPresent: booleanOrFalse(dovi.elPresent),
      blPresent: booleanOrFalse(dovi.blPresent),
      sidecar: sidecar.sourceFile
        ? {
            sourceFile: sidecar.sourceFile,
            rawKind: sidecar.rawKind,
            matchedClipName: sidecar.matchedClipName || null
          }
        : null
    }
  };
}

function validateProcessingPolicy(metadata) {
  const errors = [];

  if (metadata.sourceKind === "hls_package" && metadata.mode !== "copy") {
    errors.push("Prepackaged HLS uploads must use mode=copy.");
  }

  if (HDR_MASTER_TYPES.has(metadata.masterType) && metadata.mode !== "copy") {
    errors.push(`${metadata.masterType} masters must use mode=copy to preserve HDR color metadata.`);
  }

  if (metadata.masterType === "dolby_vision" && metadata.mode !== "copy") {
    errors.push("Dolby Vision masters cannot be transcoded.");
  }

  if (metadata.isDerivative && !metadata.derivedFromMasterId) {
    errors.push("Derivative masters must include derivedFromMasterId.");
  }

  if ((metadata.conversionIntent || metadata.conversionLutOrFilter) && !metadata.isDerivative) {
    errors.push("Conversion metadata can only be attached to derivative masters.");
  }

  if (errors.length) {
    throwColorContractError(errors);
  }
}

function validateColorContract(metadata, contract, context = "source") {
  const errors = [];

  for (const field of COLOR_REQUIRED_FIELDS) {
    if (contract[field] === undefined || contract[field] === null || contract[field] === "") {
      errors.push(`${context}: missing ${field}.`);
    }
  }

  const expectedRange = expectedVideoRange(metadata, contract);
  if (expectedRange && contract.hlsVideoRange !== expectedRange) {
    errors.push(`${context}: HLS VIDEO-RANGE must be ${expectedRange}, got ${contract.hlsVideoRange || "missing"}.`);
  }

  if (metadata.masterType === "sdr") {
    if (contract.colorPrimaries !== "bt709") {
      errors.push(`${context}: SDR masters must use BT.709 primaries.`);
    }
    if (contract.colorTransfer !== "bt709") {
      errors.push(`${context}: SDR masters must use BT.709 transfer.`);
    }
  }

  if (metadata.masterType === "hdr10") {
    validateHdrGamut(contract, context, errors);
    if (contract.colorTransfer !== "smpte2084") {
      errors.push(`${context}: HDR10 masters must use smpte2084/PQ transfer.`);
    }
    if (!contract.bitDepth || contract.bitDepth < 10) {
      errors.push(`${context}: HDR10 masters must be 10-bit or higher.`);
    }
    if (!contract.hdrStaticMetadata.masteringDisplayPresent) {
      errors.push(`${context}: HDR10 mastering display metadata is missing.`);
    }
    if (!contract.hdrStaticMetadata.contentLightLevelPresent) {
      errors.push(`${context}: HDR10 MaxCLL/MaxFALL metadata is missing.`);
    }
  }

  if (metadata.masterType === "hlg") {
    validateHdrGamut(contract, context, errors);
    if (contract.colorTransfer !== "arib-std-b67") {
      errors.push(`${context}: HLG masters must use arib-std-b67/HLG transfer.`);
    }
    if (!contract.bitDepth || contract.bitDepth < 10) {
      errors.push(`${context}: HLG masters must be 10-bit or higher.`);
    }
  }

  if (metadata.masterType === "dolby_vision") {
    validateHdrGamut(contract, context, errors);
    if (!contract.bitDepth || contract.bitDepth < 10) {
      errors.push(`${context}: Dolby Vision masters must be 10-bit or higher.`);
    }
    if (!contract.dolbyMetadata.profile && !contract.dolbyMetadata.rpuPresent) {
      errors.push(`${context}: Dolby Vision profile or RPU metadata is missing.`);
    }
    if (!contract.hlsVideoRange) {
      errors.push(`${context}: Dolby Vision VIDEO-RANGE could not be inferred from the base layer transfer.`);
    }
  }

  return errors;
}

function validateHdrGamut(contract, context, errors) {
  if (!["bt2020", "smpte432", "smpte431"].includes(contract.colorPrimaries)) {
    errors.push(
      `${context}: HDR primaries must be bt2020, smpte432/P3-D65, or smpte431/DCI-P3.`
    );
  }

  if (contract.colorPrimaries === "smpte432" && contract.displayGamut !== "p3_d65") {
    errors.push(`${context}: smpte432 must be stored as P3-D65(smpte432).`);
  }

  if (contract.colorPrimaries === "smpte431" && contract.displayGamut !== "dci_p3") {
    errors.push(`${context}: smpte431 must be stored as DCI-P3(smpte431).`);
  }
}

function compareColorContracts(sourceContract, outputContract) {
  const fields = [
    "codecName",
    "pixelFormat",
    "bitDepth",
    "colorPrimaries",
    "displayGamut",
    "colorTransfer",
    "matrixCoefficients",
    "colorRange",
    "chromaLocation",
    "hlsVideoRange"
  ];
  const errors = [];

  for (const field of fields) {
    const sourceValue = sourceContract[field] ?? null;
    const outputValue = outputContract[field] ?? null;
    if (sourceValue !== outputValue) {
      errors.push(`output: ${field} changed from ${sourceValue || "missing"} to ${outputValue || "missing"}.`);
    }
  }

  return errors;
}

function throwColorContractError(errors) {
  const error = httpError(422, `Color contract verification failed: ${errors.join(" ")}`);
  error.verificationErrors = errors;
  throw error;
}

async function parseDolbyProfileFile(file, clipName = "") {
  if (!file) {
    return {};
  }

  const buffer = await fsp.readFile(file.packagePath || file.tempPath);
  const text = decodeTextBuffer(buffer);
  const normalized = text.replace(/\u0000/g, " ");
  const lowerName = file.filename.toLowerCase();
  const targetText = clipName ? extractDolbyXmlClipBlock(normalized, clipName) || normalized : normalized;

  return {
    profile: matchFirst(targetText, [
      /dolby\s*vision\s*profile\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i,
      /\bdv[_-]?profile\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i,
      /\bdovi[_-]?profile\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i,
      /dvmd-fw\/([0-9]+)_([0-9]+)(?:_[0-9]+)?/i,
      /\bprofile(?:number|id|version)?\s*[:=]\s*["']?\s*([0-9]+(?:\.[0-9]+)?)/i,
      /\bprofile(?:number|id|version)?\s*=\s*["']\s*([0-9]+(?:\.[0-9]+)?)/i,
      /<[^>]*profile[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/[^>]*profile[^>]*>/i,
      /<[^>]*(?:profileversion|profilenumber|profileid)[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/[^>]*>/i,
      /\bprofile\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i,
      /dvhe\.([0-9]{2})\./i,
      /dvh[ei]\.([0-9]{2})\./i,
      /\bp([0-9]+(?:\.[0-9]+)?)\b/i
    ]),
    level: matchFirst(targetText, [
      /\bdv[_-]?level\s*[:=]\s*([0-9]+)/i,
      /\bdovi[_-]?level\s*[:=]\s*([0-9]+)/i,
      /\blevel(?:id|number)?\s*[:=]\s*["']?\s*([0-9]+)/i,
      /\blevel(?:id|number)?\s*=\s*["']\s*([0-9]+)/i,
      /<[^>]*level[^>]*>\s*([0-9]+)\s*<\/[^>]*level[^>]*>/i,
      /<[^>]*(?:levelid|levelnumber)[^>]*>\s*([0-9]+)\s*<\/[^>]*>/i,
      /\blevel\s*[:=]\s*([0-9]+)/i,
      /dvhe\.[0-9]{2}\.([0-9]{2})/i
    ]),
    compatibilityId: matchFirst(targetText, [
      /\bcompatibility(?:\s*id)?\s*[:=]\s*([A-Za-z0-9_.-]+)/i,
      /\bcompatibility(?:id)?\s*=\s*["']\s*([A-Za-z0-9_.-]+)/i,
      /<[^>]*compatibility[^>]*>\s*([A-Za-z0-9_.-]+)\s*<\/[^>]*compatibility[^>]*>/i,
      /\bbl[_-]?signal[_-]?compatibility[_-]?id\s*[:=]\s*([A-Za-z0-9_.-]+)/i,
      /<[^>]*bl[^>]*signal[^>]*compatibility[^>]*>\s*([A-Za-z0-9_.-]+)\s*<\/[^>]*>/i
    ]),
    matchedClipName: clipName && targetText !== normalized ? clipName : null,
    rawKind: lowerName.endsWith(".xml") ? "xml" : path.extname(lowerName).replace(".", "") || "unknown",
    sourceFile: file.filename
  };
}

async function parseDolbyProfileFiles(files = [], clipName = "") {
  for (const file of files) {
    try {
      const parsed = await parseDolbyProfileFile(file, clipName);
      if (parsed.profile || parsed.level || parsed.compatibilityId) {
        return parsed;
      }
    } catch {
      // Ignore non-text sidecars here; the embedded stream probe remains authoritative.
    }
  }

  return {};
}

function extractDolbyXmlClipBlock(text, clipName) {
  const target = clipName.trim();
  if (!target) {
    return null;
  }

  const index = text.toLowerCase().indexOf(target.toLowerCase());
  if (index === -1) {
    return null;
  }

  const starts = [
    text.lastIndexOf("<Shot", index),
    text.lastIndexOf("<Clip", index),
    text.lastIndexOf("<Segment", index),
    text.lastIndexOf("<Asset", index),
    text.lastIndexOf("<Event", index)
  ].filter((value) => value >= 0);
  const start = starts.length ? Math.max(...starts) : Math.max(0, index - 8000);

  const tail = text.slice(index);
  const endCandidates = ["</Shot>", "</Clip>", "</Segment>", "</Asset>", "</Event>"]
    .map((tag) => {
      const found = tail.indexOf(tag);
      return found >= 0 ? index + found + tag.length : -1;
    })
    .filter((value) => value >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : Math.min(text.length, index + 8000);

  return text.slice(start, end);
}

function decodeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return swapUtf16Be(buffer.subarray(2)).toString("utf16le");
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }

  return buffer.toString("utf8");
}

function swapUtf16Be(buffer) {
  const output = Buffer.from(buffer);
  for (let index = 0; index + 1 < output.length; index += 2) {
    const byte = output[index];
    output[index] = output[index + 1];
    output[index + 1] = byte;
  }
  return output;
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match?.[2] && pattern.source.includes("dvmd-fw")) {
      return `${Number(match[1])}.${Number(match[2])}`;
    }

    if (match?.[1]) {
      const value = match[1].replace(/^0+(\d)/, "$1");
      return pattern.source.includes("dvhe") ? String(Number(value)) : value;
    }
  }

  return null;
}

function normalizeDolbyProfileVersion(profile, compatibilityId) {
  const normalizedProfile = normalizeNumberLabel(profile);
  if (!normalizedProfile) {
    return null;
  }

  if (normalizedProfile.includes(".")) {
    return normalizedProfile;
  }

  if (normalizedProfile === "8") {
    const normalizedCompatibility = normalizeNumberLabel(compatibilityId);
    if (normalizedCompatibility === "1") return "8.1";
    if (normalizedCompatibility === "2") return "8.2";
    if (normalizedCompatibility === "4") return "8.4";
  }

  return normalizedProfile;
}

function normalizeNumberLabel(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  const match = text.match(/[0-9]+(?:\.[0-9]+)?/);
  if (!match) return text;

  return match[0]
    .split(".")
    .map((part) => String(Number(part)))
    .join(".");
}

function validateDolbyVisionUpload(metadata, probe, sidecar) {
  if (metadata.masterType !== "dolby_vision") {
    return;
  }

  const dovi = extractDolbyVisionMetadata(probe);
  const profile = sidecar.profile || stringOrNull(dovi.profile);
  const hasRpu = booleanOrFalse(dovi.rpuPresent);

  if (!profile && !hasRpu) {
    const sidecarHint = sidecar.sourceFile
      ? ` A Dolby sidecar candidate (${sidecar.sourceFile}) was scanned but no profile value was found in it.`
      : "";
    throw httpError(
      422,
      `Dolby Vision metadata was not detected. Use a source video with embedded DOVI/RPU metadata, or upload the complete Dolby Vision master package containing its XML/RPU/IMF metadata.${sidecarHint} If the XML uses a different clip name, fill the XML clip name field with the clip name shown inside the XML.`
    );
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function stringOrNull(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function booleanOrFalse(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  return value === true || value === 1 || value === "1" || value === "true";
}

function prettyCodec(codecName, masterType) {
  const value = String(codecName || "").toLowerCase();
  if (value === "hevc" || value === "h265") {
    return "HEVC / H.265";
  }

  if (value === "h264") {
    return "H.264 / AVC";
  }

  if (value.startsWith("prores")) {
    return "Apple ProRes";
  }

  if (value === "jpeg2000") {
    return "JPEG 2000";
  }

  return defaultCodec(masterType, masterType === "dolby_vision" ? "copy" : "transcode");
}

function prettyColorSpace(probe, masterType) {
  const primaries = normalizePrimaries(probe.color_primaries);
  return primaries.label || defaultColorSpace(masterType);
}

function prettyTransferFunction(probe, masterType) {
  const transfer = normalizeTransfer(probe.color_transfer);
  return transfer.label || defaultTransferFunction(masterType);
}

function inferBitDepth(probe, masterType) {
  const explicit = parseInteger(probe.bits_per_raw_sample);
  if (explicit) {
    return explicit;
  }

  const pixFmt = String(probe.pix_fmt || "");
  const match = pixFmt.match(/(?:p|le|be)(10|12|16)/);
  if (match) {
    return Number(match[1]);
  }

  return defaultBitDepth(masterType);
}

async function directusRequest(pathname, token, options = {}) {
  const {
    directusAuthRetried = false,
    ...requestOptions
  } = options;
  const method = String(requestOptions.method || "GET").toUpperCase();
  let response;
  try {
    response = await fetch(`${DIRECTUS_URL}${pathname}`, {
      ...requestOptions,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(requestOptions.headers || {})
      },
      body:
        requestOptions.body && typeof requestOptions.body !== "string"
          ? JSON.stringify(requestOptions.body)
          : requestOptions.body
    });
  } catch (cause) {
    throw directusTransportError(method, pathname, cause);
  }

  if (
    token &&
    !directusAuthRetried &&
    [401, 403].includes(response.status)
  ) {
    await response.arrayBuffer().catch(() => {});
    const refreshedToken = await refreshDirectusLogin(token);
    return directusRequest(pathname, refreshedToken, {
      ...requestOptions,
      directusAuthRetried: true
    });
  }

  let text;
  try {
    text = await response.text();
  } catch (cause) {
    if (!response.ok) {
      const error = httpError(
        response.status,
        `Directus ${method} ${pathname} failed: ${response.statusText}`
      );
      error.directusHttpStatus = response.status;
      error.directusRequestSent = true;
      error.cause = cause;
      throw error;
    }
    const error = directusTransportError(method, pathname, cause);
    error.directusResponseStatus = response.status;
    throw error;
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (cause) {
      if (!response.ok) {
        const error = httpError(
          response.status,
          `Directus ${method} ${pathname} failed: ${text || response.statusText}`
        );
        error.directusHttpStatus = response.status;
        error.directusRequestSent = true;
        throw error;
      }

      const error = httpError(502, `Directus ${method} ${pathname} returned invalid JSON.`);
      error.directusRequestSent = true;
      error.directusResponseStatus = response.status;
      error.directusAmbiguous = isDirectusMutationMethod(method);
      error.cause = cause;
      throw error;
    }
  }

  if (!response.ok) {
    const message = data?.errors?.[0]?.message || text || response.statusText;
    const error = httpError(
      response.status,
      `Directus ${method} ${pathname} failed: ${message}`
    );
    error.directusHttpStatus = response.status;
    error.directusRequestSent = true;
    throw error;
  }

  if (!text && method !== "DELETE" && method !== "HEAD") {
    const error = httpError(502, `Directus ${method} ${pathname} returned an empty response.`);
    error.directusRequestSent = true;
    error.directusResponseStatus = response.status;
    error.directusAmbiguous = isDirectusMutationMethod(method);
    throw error;
  }

  return data;
}

function isDirectusMutationMethod(method) {
  return ["POST", "PATCH", "PUT"].includes(method);
}

function directusTransportError(method, pathname, cause) {
  const error = httpError(502, `Directus ${method} ${pathname} did not return a response.`);
  error.directusRequestSent = true;
  error.directusAmbiguous = isDirectusMutationMethod(method);
  error.cause = cause;
  return error;
}

async function directusUploadFile(token, file, title, options = {}) {
  if (!file) {
    return null;
  }

  const buffer = await fsp.readFile(file.tempPath);
  const reconciliationTag = String(options.reconciliationTag || "").trim();

  async function upload(accessToken, authRetried = false) {
    const form = new FormData();
    if (title) {
      form.append("title", title);
    }
    if (reconciliationTag) {
      form.append("description", reconciliationTag);
    }
    form.append(
      "file",
      new Blob([buffer], { type: file.mimeType || "application/octet-stream" }),
      file.filename
    );

    let response;
    try {
      response = await fetch(`${DIRECTUS_URL}/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        body: form
      });
    } catch (cause) {
      throw directusTransportError("POST", "/files", cause);
    }

    if (
      !authRetried &&
      [401, 403].includes(response.status)
    ) {
      await response.arrayBuffer().catch(() => {});
      const refreshedToken = await refreshDirectusLogin(accessToken);
      return upload(refreshedToken, true);
    }

    let text;
    try {
      text = await response.text();
    } catch (cause) {
      const error = directusTransportError("POST", "/files", cause);
      error.directusResponseStatus = response.status;
      throw error;
    }

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (cause) {
      const error = httpError(502, "Directus file upload returned invalid JSON.");
      error.directusRequestSent = true;
      error.directusResponseStatus = response.status;
      error.directusAmbiguous = response.ok;
      error.cause = cause;
      throw error;
    }

    if (!response.ok) {
      const message = data?.errors?.[0]?.message || text || response.statusText;
      const error = httpError(response.status, `Directus file upload failed: ${message}`);
      error.directusHttpStatus = response.status;
      error.directusRequestSent = true;
      throw error;
    }

    if (!data?.data?.id) {
      const error = httpError(
        502,
        "Directus file upload response did not include a file id."
      );
      error.directusRequestSent = true;
      error.directusResponseStatus = response.status;
      error.directusAmbiguous = true;
      throw error;
    }

    return data.data.id;
  }

  try {
    return await upload(token);
  } catch (error) {
    if (error.directusAmbiguous && reconciliationTag) {
      try {
        const reconciledFileId = await findDirectusFileByUploadTag(
          token,
          reconciliationTag
        );
        if (reconciledFileId) {
          return reconciledFileId;
        }
      } catch (reconciliationError) {
        error.reconciliationError = reconciliationError;
      }
    }
    throw error;
  }
}

const DIRECTUS_TOKEN_SAFETY_MARGIN_MS = 30_000;
const DIRECTUS_TOKEN_FALLBACK_TTL_MS = 5 * 60_000;
const directusTokenCache = createDirectusTokenCache({
  login: async () => {
    const data = await directusRequest("/auth/login", null, {
      method: "POST",
      body: {
        email: DIRECTUS_EMAIL,
        password: DIRECTUS_PASSWORD
      }
    });
    return {
      token: data?.data?.access_token,
      expiresIn: data?.data?.expires
    };
  },
  safetyMarginMs: DIRECTUS_TOKEN_SAFETY_MARGIN_MS,
  fallbackTtlMs: DIRECTUS_TOKEN_FALLBACK_TTL_MS
});

function normalizeDirectusLoginError(error) {
  if ([401, 403].includes(error.directusHttpStatus || error.statusCode)) {
    const upstreamError = httpError(
      502,
      "Directus service authentication failed."
    );
    upstreamError.cause = error;
    return upstreamError;
  }
  return error;
}

async function directusLogin() {
  try {
    return await directusTokenCache.get();
  } catch (error) {
    throw normalizeDirectusLoginError(error);
  }
}

async function refreshDirectusLogin(failedToken) {
  try {
    return await directusTokenCache.refresh(failedToken);
  } catch (error) {
    throw normalizeDirectusLoginError(error);
  }
}

async function findPostBySlug(token, slug) {
  const params = new URLSearchParams({
    "filter[slug][_eq]": slug,
    fields: "id,title,slug,content,cover_image,tags,category,published,created_at,updated_at",
    limit: "1"
  });
  const data = await directusRequest(`/items/posts?${params.toString()}`, token);
  return data.data?.[0] || null;
}

async function getPostById(token, articleId) {
  const fields = [
    "id",
    "title",
    "slug",
    "content",
    "cover_image",
    "tags",
    "category",
    "published",
    "created_at",
    "updated_at"
  ].join(",");
  const data = await directusRequest(
    `/items/posts/${encodeURIComponent(articleId)}?fields=${fields}`,
    token
  );
  return data.data;
}

function directusFileId(value) {
  if (value && typeof value === "object") {
    return value.id ? String(value.id) : null;
  }
  return value === undefined || value === null || value === "" ? null : String(value);
}

function normalizedDirectusTags(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function postMatchesMutation(record, payload, articleId) {
  if (!record || (articleId && String(record.id) !== String(articleId))) {
    return false;
  }

  return (
    String(record.title || "") === String(payload.title || "") &&
    String(record.slug || "") === String(payload.slug || "") &&
    String(record.content || "") === String(payload.content || "") &&
    directusFileId(record.cover_image) === directusFileId(payload.cover_image) &&
    String(record.category || "") === String(payload.category || "") &&
    JSON.stringify(normalizedDirectusTags(record.tags)) ===
      JSON.stringify(normalizedDirectusTags(payload.tags)) &&
    parseBoolean(record.published, false) === Boolean(payload.published) &&
    Number.isFinite(Date.parse(record.updated_at)) &&
    Date.parse(record.updated_at) === Date.parse(payload.updated_at)
  );
}

async function reconcilePostMutation(token, article, payload) {
  try {
    const record = article.articleId
      ? await getPostById(token, article.articleId)
      : await findPostBySlug(token, article.slug);
    return postMatchesMutation(record, payload, article.articleId) ? record : null;
  } catch (error) {
    console.warn(`[articles] Could not reconcile an ambiguous Directus write: ${error.message}`);
    return null;
  }
}

async function normalizePostMutationError(error, token, article) {
  const directusStatus = error.directusHttpStatus || error.statusCode;
  if (![400, 409, 422].includes(directusStatus)) {
    return error;
  }

  let conflictingPost = null;
  try {
    conflictingPost = await findPostBySlug(token, article.slug);
  } catch {
    // Keep the original Directus error if the conflict lookup is unavailable.
  }

  const conflictsWithAnotherPost =
    conflictingPost &&
    (!article.articleId || String(conflictingPost.id) !== String(article.articleId));
  const reportsUniqueConstraint = /(?:unique|duplicate)/i.test(error.message || "");

  if (conflictsWithAnotherPost || reportsUniqueConstraint) {
    return httpError(409, `An article with slug ${article.slug} already exists.`);
  }

  return error;
}

function ambiguousPostMutationError(cause) {
  const error = httpError(
    502,
    "Directus did not return a verifiable article write result; uploaded files were retained for safety."
  );
  error.preserveUploadedFiles = true;
  error.cause = cause;
  return error;
}

async function rollbackDirectusFiles(token, fileIds) {
  for (const fileId of [...fileIds].reverse()) {
    try {
      await directusRequest(`/files/${encodeURIComponent(fileId)}`, token, {
        method: "DELETE"
      });
    } catch (error) {
      console.error(`[articles] Could not roll back Directus file ${fileId}: ${error.message}`);
    }
  }
}

async function handleArticleCreate(req, res) {
  let parsed = null;
  let directusToken = null;
  let articleCommitted = false;
  let preserveUploadedFiles = false;
  const uploadedFileIds = [];

  try {
    requireArticleAuth(req);
    parsed = await parseArticleMultipart(req);
    const article = normalizeArticleUpload(parsed.fields, parsed.files);
    directusToken = await directusLogin();

    let existingPost = null;
    if (article.articleId) {
      try {
        existingPost = await getPostById(directusToken, article.articleId);
      } catch (error) {
        if ((error.directusHttpStatus || error.statusCode) === 404) {
          throw httpError(404, `Article ${article.articleId} was not found.`);
        }
        throw error;
      }
    }

    const slugOwner = await findPostBySlug(directusToken, article.slug);
    if (
      slugOwner &&
      (!existingPost || String(slugOwner.id) !== String(existingPost.id))
    ) {
      throw httpError(409, `An article with slug ${article.slug} already exists.`);
    }

    let coverImageId = directusFileId(existingPost?.cover_image);
    if (article.cover) {
      coverImageId = await directusUploadFile(
        directusToken,
        article.cover,
        `${article.title} cover`
      );
      uploadedFileIds.push(coverImageId);
    } else if (article.removeCover) {
      coverImageId = null;
    }

    const uploadedImages = [];
    for (const inlineImage of article.inlineImages) {
      const fileId = await directusUploadFile(
        directusToken,
        inlineImage.file,
        inlineImage.alt || inlineImage.name || `${article.title} image`
      );
      uploadedFileIds.push(fileId);
      uploadedImages.push({
        key: inlineImage.key,
        name: inlineImage.name,
        alt: inlineImage.alt,
        id: fileId,
        url: `/api/assets/${fileId}`
      });
    }

    const now = new Date().toISOString();
    const storedContent = replaceInlineImagePlaceholders(article.content, uploadedImages);
    const postPayload = {
      title: article.title,
      slug: article.slug,
      content: storedContent,
      cover_image: coverImageId,
      tags: article.tags,
      category: article.category,
      published: article.published,
      updated_at: now,
      ...(!article.articleId ? { created_at: now } : {})
    };
    const mutationPath = article.articleId
      ? `/items/posts/${encodeURIComponent(article.articleId)}`
      : "/items/posts";
    const mutationMethod = article.articleId ? "PATCH" : "POST";
    let savedPost;

    try {
      const mutationResponse = await directusRequest(mutationPath, directusToken, {
        method: mutationMethod,
        body: postPayload
      });
      if (!mutationResponse?.data?.id) {
        const missingResultError = httpError(
          502,
          "Directus article write response did not include the saved item."
        );
        missingResultError.directusAmbiguous = true;
        throw missingResultError;
      }
      savedPost = mutationResponse.data;
    } catch (error) {
      if (error.directusAmbiguous) {
        preserveUploadedFiles = true;
        const reconciledPost = await reconcilePostMutation(
          directusToken,
          article,
          postPayload
        );
        if (!reconciledPost) {
          throw ambiguousPostMutationError(error);
        }
        savedPost = reconciledPost;
      } else {
        throw await normalizePostMutationError(error, directusToken, article);
      }
    }

    articleCommitted = true;
    const currentCoverImageId = directusFileId(
      Object.prototype.hasOwnProperty.call(savedPost, "cover_image")
        ? savedPost.cover_image
        : postPayload.cover_image
    );
    const savedSlug = savedPost.slug || article.slug;

    sendJson(res, article.articleId ? 200 : 201, {
      status: "ok",
      operation: article.articleId ? "updated" : "created",
      article: {
        id: savedPost.id || article.articleId,
        title: savedPost.title || article.title,
        slug: savedSlug,
        published: parseBoolean(savedPost.published, article.published),
        url: `/posts/${savedSlug}`,
        coverImage: currentCoverImageId
          ? { id: currentCoverImageId, url: `/api/assets/${currentCoverImageId}` }
          : null
      },
      uploadedImages
    });
  } catch (error) {
    preserveUploadedFiles = preserveUploadedFiles || Boolean(error.preserveUploadedFiles);
    if (
      directusToken &&
      !articleCommitted &&
      !preserveUploadedFiles &&
      uploadedFileIds.length
    ) {
      await rollbackDirectusFiles(directusToken, uploadedFileIds);
    }

    if (!res.headersSent) {
      const clientError =
        directusToken && [401, 403].includes(error.directusHttpStatus || 0)
          ? httpError(502, "Directus service authorization failed.")
          : error;
      sendJson(res, clientError.statusCode || 500, {
        status: "error",
        error: clientError.message
      });
    }
  } finally {
    if (parsed?.tempDir) {
      await fsp.rm(parsed.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const ALBUM_ITEM_FIELDS = [
  "id",
  "title",
  "slug",
  "description",
  "cover_image",
  "published",
  "created_at",
  "updated_at"
].join(",");

const ALBUM_PHOTO_FIELDS = [
  "id",
  "album_id",
  "sdr_image",
  "hdr_image",
  "caption",
  "alt_text",
  "hdr_transfer",
  "hdr_primaries",
  "hdr_bit_depth",
  "film_scan_frame_id",
  "film_stock",
  "film_process",
  "film_scanner",
  "film_frame_format",
  "renditions.id",
  "renditions.kind",
  "renditions.file",
  "renditions.transfer",
  "renditions.primaries",
  "renditions.bit_depth",
  "renditions.is_default",
  "published",
  "sort_order",
  "created_at",
  "updated_at"
].join(",");

function normalizeAlbumId(value, label = "album id") {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw httpError(400, `${label} must be a positive integer.`);
  }
  return text;
}

function normalizeAlbumText(value, field, maxLength, options = {}) {
  const text = String(value ?? "").trim();
  if (options.required && !text) {
    throw httpError(400, `${field} is required.`);
  }
  if (text.length > maxLength) {
    throw httpError(400, `${field} must be ${maxLength} characters or fewer.`);
  }
  return text || null;
}

function parseAlbumBoolean(value, fallback, field = "published") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw httpError(400, `${field} must be a boolean.`);
}

function slugifyAlbumTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    .replace(/-+$/g, "");
}

function fallbackAlbumSlug() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `album-${date}-${crypto.randomBytes(4).toString("hex")}`;
}

async function findAlbumBySlug(token, slug) {
  const params = new URLSearchParams({
    "filter[slug][_eq]": slug,
    fields: ALBUM_ITEM_FIELDS,
    limit: "1"
  });
  const data = await directusRequest(`/items/albums?${params.toString()}`, token);
  return data.data?.[0] || null;
}

async function getAlbumById(token, albumId) {
  try {
    const data = await directusRequest(
      `/items/albums/${encodeURIComponent(albumId)}?fields=${encodeURIComponent(ALBUM_ITEM_FIELDS)}`,
      token
    );
    return data.data;
  } catch (error) {
    if ((error.directusHttpStatus || error.statusCode) === 404) {
      throw httpError(404, `Album ${albumId} was not found.`);
    }
    throw error;
  }
}

async function getAlbumPhoto(token, albumId, photoId) {
  let photo;
  try {
    const data = await directusRequest(
      `/items/album_photos/${encodeURIComponent(photoId)}?fields=${encodeURIComponent(ALBUM_PHOTO_FIELDS)}`,
      token
    );
    photo = data.data;
  } catch (error) {
    if ((error.directusHttpStatus || error.statusCode) === 404) {
      throw httpError(404, `Album photo ${photoId} was not found.`);
    }
    throw error;
  }

  if (String(directusRelationId(photo.album_id)) !== String(albumId)) {
    throw httpError(404, `Album photo ${photoId} was not found in album ${albumId}.`);
  }
  return photo;
}

async function listAlbumPhotos(token, albumId) {
  const params = new URLSearchParams({
    "filter[album_id][_eq]": albumId,
    fields: ALBUM_PHOTO_FIELDS,
    sort: "sort_order,id",
    limit: "-1"
  });
  const data = await directusRequest(
    `/items/album_photos?${params.toString()}`,
    token
  );
  return Array.isArray(data.data) ? data.data : [];
}

function albumUploadTag(batchId, index, rendition) {
  return `album-upload:${batchId}:${index}:${rendition}`;
}

async function findDirectusFileByUploadTag(token, reconciliationTag) {
  const params = new URLSearchParams({
    "filter[description][_eq]": reconciliationTag,
    fields: "id,description",
    limit: "2"
  });
  const data = await directusRequest(`/files?${params.toString()}`, token);
  const files = Array.isArray(data.data) ? data.data : [];
  if (files.length > 1) {
    throw httpError(
      409,
      `Multiple Directus files use reconciliation tag ${reconciliationTag}.`
    );
  }
  return directusFileId(files[0]?.id);
}

async function findAlbumPhotoBySdrFile(token, albumId, sdrFileId) {
  const params = new URLSearchParams({
    "filter[album_id][_eq]": albumId,
    "filter[sdr_image][_eq]": sdrFileId,
    fields: ALBUM_PHOTO_FIELDS,
    limit: "2"
  });
  const data = await directusRequest(
    `/items/album_photos?${params.toString()}`,
    token
  );
  const photos = Array.isArray(data.data) ? data.data : [];
  if (photos.length > 1) {
    throw httpError(
      409,
      `Multiple album photos reference SDR file ${sdrFileId}.`
    );
  }
  return photos[0] || null;
}

async function findAlbumPhotosBySdrFiles(token, albumId, sdrFileIds) {
  const uniqueIds = [...new Set(sdrFileIds.filter(Boolean).map(String))];
  if (!uniqueIds.length) {
    return [];
  }
  const params = new URLSearchParams({
    "filter[album_id][_eq]": albumId,
    "filter[sdr_image][_in]": uniqueIds.join(","),
    fields: ALBUM_PHOTO_FIELDS,
    limit: "-1"
  });
  const data = await directusRequest(
    `/items/album_photos?${params.toString()}`,
    token
  );
  return Array.isArray(data.data) ? data.data : [];
}

function directusRelationId(value) {
  if (value && typeof value === "object") {
    return value.id ?? null;
  }
  return value ?? null;
}

function serializeManagedAlbum(album) {
  const photos = Array.isArray(album.photos)
    ? [...album.photos].sort((left, right) => {
        const orderDifference =
          Number(left?.sort_order || 0) - Number(right?.sort_order || 0);
        return orderDifference || Number(left?.id || 0) - Number(right?.id || 0);
      })
    : [];
  const publishedPhotos = photos.filter((photo) =>
    parseBoolean(photo?.published, false)
  );
  return {
    id: album.id,
    title: album.title || "",
    slug: album.slug || "",
    description: album.description || "",
    coverImage: directusFileId(album.cover_image),
    published: parseBoolean(album.published, false),
    photoCount: photos.length,
    publishedPhotoCount: publishedPhotos.length,
    hdrPhotoCount: photos.filter((photo) => directusFileId(photo?.hdr_image)).length,
    photos: photos.map(serializeManagedPhoto),
    createdAt: album.created_at || null,
    updatedAt: album.updated_at || null,
    url: `/albums/${album.slug}`
  };
}

async function handleAlbumManageList(res) {
  const token = await directusLogin();
  const fields = [
    ALBUM_ITEM_FIELDS,
    ...ALBUM_PHOTO_FIELDS.split(",").map((field) => `photos.${field}`)
  ].join(",");
  const params = new URLSearchParams({
    fields,
    sort: "-created_at,-id",
    "deep[photos][_sort]": "sort_order,id",
    limit: "-1"
  });
  const data = await directusRequest(`/items/albums?${params.toString()}`, token);
  const albums = Array.isArray(data.data)
    ? data.data.map(serializeManagedAlbum)
    : [];

  sendJson(res, 200, { status: "ok", albums });
}

async function createUniqueAlbumSlug(token, title, requestedSlug) {
  const explicitSlug = String(requestedSlug ?? "").trim().toLowerCase();
  if (explicitSlug) {
    if (explicitSlug.length > 200) {
      throw httpError(400, "slug must be 200 characters or fewer.");
    }
    validateSlug(explicitSlug);
    if (await findAlbumBySlug(token, explicitSlug)) {
      throw httpError(409, `An album with slug ${explicitSlug} already exists.`);
    }
    return explicitSlug;
  }

  const base = slugifyAlbumTitle(title) || fallbackAlbumSlug();
  if (!(await findAlbumBySlug(token, base))) {
    return base;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = crypto.randomBytes(3).toString("hex");
    const candidate = `${base.slice(0, 193).replace(/-+$/g, "")}-${suffix}`;
    if (!(await findAlbumBySlug(token, candidate))) {
      return candidate;
    }
  }
  throw httpError(409, "Could not generate a unique album slug.");
}

async function handleAlbumCreate(req, res) {
  const body = await readJsonBody(req);
  const title = normalizeAlbumText(body.title, "title", 200, { required: true });
  const description = normalizeAlbumText(body.description, "description", 5000);
  const published = parseAlbumBoolean(body.published, true);
  const token = await directusLogin();
  const slug = await createUniqueAlbumSlug(token, title, body.slug);
  const now = new Date().toISOString();

  try {
    const result = await directusRequest("/items/albums", token, {
      method: "POST",
      body: {
        title,
        slug,
        description,
        published,
        cover_image: null,
        created_at: now,
        updated_at: now
      }
    });
    const album = result.data;
    sendJson(res, 201, {
      status: "ok",
      album: serializeManagedAlbum({ ...album, photos: [] })
    });
  } catch (error) {
    if (
      [400, 409, 422].includes(error.directusHttpStatus || error.statusCode) &&
      /(?:unique|duplicate)/i.test(error.message || "")
    ) {
      throw httpError(409, `An album with slug ${slug} already exists.`);
    }
    throw error;
  }
}

function pickAlbumPatch(body) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    patch.title = normalizeAlbumText(body.title, "title", 200, { required: true });
  }
  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    patch.description = normalizeAlbumText(body.description, "description", 5000);
  }
  if (Object.prototype.hasOwnProperty.call(body, "published")) {
    patch.published = parseAlbumBoolean(body.published, false);
  }
  if (Object.prototype.hasOwnProperty.call(body, "slug")) {
    throw httpError(400, "Album slugs cannot be changed after creation.");
  }
  if (!Object.keys(patch).length) {
    throw httpError(400, "No editable album fields were provided.");
  }
  return patch;
}

async function handleAlbumPatch(req, res, albumId) {
  const body = await readJsonBody(req);
  const patch = pickAlbumPatch(body);
  const token = await directusLogin();
  await getAlbumById(token, albumId);
  const result = await directusRequest(
    `/items/albums/${encodeURIComponent(albumId)}`,
    token,
    {
      method: "PATCH",
      body: { ...patch, updated_at: new Date().toISOString() }
    }
  );
  const photos = await listAlbumPhotos(token, albumId);
  sendJson(res, 200, {
    status: "ok",
    album: serializeManagedAlbum({ ...result.data, photos })
  });
}

function parseAlbumUploadManifest(rawManifest, pairs) {
  if (!rawManifest) {
    throw httpError(400, "manifest is required.");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawManifest);
  } catch {
    throw httpError(400, "manifest must be valid JSON.");
  }

  const entries = Array.isArray(parsed) ? parsed : parsed?.photos;
  if (!Array.isArray(entries)) {
    throw httpError(400, "manifest must be an array or contain a photos array.");
  }

  const entryByKey = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw httpError(400, "Each manifest photo must be an object.");
    }

    let key;
    try {
      key = manifestPhotoPairKey(entry);
    } catch (error) {
      throw httpError(400, error.message);
    }
    if (entryByKey.has(key)) {
      throw httpError(400, `Manifest photo basename "${key}" is duplicated.`);
    }

    entryByKey.set(key, {
      key,
      caption: normalizeAlbumText(entry.caption, "caption", 2000),
      altText: normalizeAlbumText(entry.altText ?? entry.alt_text, "altText", 500),
      published: parseAlbumBoolean(entry.published, true, "photo published")
    });
  }

  const pairKeys = new Set(pairs.map((pair) => pair.key));
  for (const key of entryByKey.keys()) {
    if (!pairKeys.has(key)) {
      throw httpError(400, `Manifest photo "${key}" has no matching SDR upload.`);
    }
  }
  for (const pair of pairs) {
    if (!entryByKey.has(pair.key)) {
      throw httpError(400, `SDR photo "${pair.key}" is missing from the manifest.`);
    }
  }

  return pairs.map((pair) => ({
    ...pair,
    ...entryByKey.get(pair.key)
  }));
}

async function validateAlbumUpload(parsed) {
  try {
    validateAlbumBatchLimits(
      parsed.files.sdrFiles,
      parsed.files.hdrFiles,
      {
        maxPhotos: MAX_ALBUM_PHOTOS,
        maxFileBytes: MAX_ALBUM_IMAGE_BYTES,
        maxBatchBytes: MAX_ALBUM_UPLOAD_BYTES
      }
    );
  } catch (error) {
    throw httpError(413, error.message);
  }

  let pairs;
  try {
    pairs = pairAlbumFiles(parsed.files.sdrFiles, parsed.files.hdrFiles);
  } catch (error) {
    throw httpError(400, error.message);
  }

  if (!pairs.length) {
    throw httpError(400, "At least one SDR photo is required.");
  }
  if (pairs.length > MAX_ALBUM_PHOTOS) {
    throw httpError(413, `At most ${MAX_ALBUM_PHOTOS} photos are allowed per batch.`);
  }

  const normalizedPairs = parseAlbumUploadManifest(parsed.fields.manifest, pairs);
  const validated = [];
  for (const pair of normalizedPairs) {
    let sdrMetadata;
    let hdrMetadata = null;
    try {
      sdrMetadata = validateSdrProbe(
        await probeAlbumImage(pair.sdr.tempPath)
      );
      if (pair.hdr) {
        hdrMetadata = validateHdrProbe(
          await probeAlbumImage(pair.hdr.tempPath)
        );
        validatePairedAspectRatio(sdrMetadata, hdrMetadata);
      }
    } catch (error) {
      throw httpError(
        422,
        `Photo "${pair.key}" failed validation: ${error.message}`
      );
    }

    validated.push({
      ...pair,
      sdrMetadata,
      hdrMetadata
    });
  }
  return validated;
}

async function probeAlbumImage(sourcePath) {
  const { stdout } = await runProcess(FFPROBE_PATH, [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_streams",
    "-of",
    "json",
    sourcePath
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error("No image stream was detected.");
  }
  return stream;
}

async function downloadDirectusAssetToFile(token, fileId, targetPath) {
  const assetUrl = new URL(
    `${DIRECTUS_URL}/assets/${encodeURIComponent(fileId)}`
  );
  const response = await fetchDirectusAsset(assetUrl, token);
  if (!response.ok) {
    throw httpError(
      response.status,
      `Could not read the existing SDR photo: ${response.statusText}.`
    );
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_ALBUM_IMAGE_BYTES
  ) {
    throw httpError(413, "The existing SDR photo exceeds the validation limit.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ALBUM_IMAGE_BYTES) {
    throw httpError(413, "The existing SDR photo exceeds the validation limit.");
  }
  await fsp.writeFile(targetPath, buffer);
}

async function deleteDirectusFileSafely(token, fileId, context = "file") {
  try {
    await directusRequest(`/files/${encodeURIComponent(fileId)}`, token, {
      method: "DELETE"
    });
    return null;
  } catch (error) {
    console.error(
      `[albums] Could not remove ${context} ${fileId}: ${error.message}`
    );
    return { fileId: String(fileId), error };
  }
}

async function rollbackAlbumUpload(
  token,
  albumId,
  photoIds,
  fileIds,
  reconciliationTags = []
) {
  const reconciled = await reconcileAlbumBatchResources({
    photoIds,
    fileIds,
    reconciliationTags,
    findFileByTag: (tag) =>
      findDirectusFileByUploadTag(token, tag),
    findPhotosBySdrFiles: (sdrFileIds) =>
      findAlbumPhotosBySdrFiles(token, albumId, sdrFileIds)
  });

  const errors = await rollbackAlbumBatch({
    photoIds: reconciled.photoIds,
    fileIds: reconciled.fileIds,
    deletePhoto: (photoId) =>
      directusRequest(
        `/items/album_photos/${encodeURIComponent(photoId)}`,
        token,
        { method: "DELETE" }
      ),
    deleteFile: (fileId) =>
      directusRequest(`/files/${encodeURIComponent(fileId)}`, token, {
        method: "DELETE"
      })
  });
  const failures = [...reconciled.errors, ...errors];
  for (const failure of failures) {
    console.error(
      `[albums] Could not roll back ${failure.kind} ${failure.id}: ${failure.error.message}`
    );
  }
  return failures;
}

function serializeManagedPhoto(photo) {
  const renditions = Array.isArray(photo.renditions)
    ? photo.renditions.map((rendition) => ({
        id: Number(rendition.id),
        kind: rendition.kind,
        file: directusFileId(rendition.file),
        transfer: rendition.transfer || null,
        primaries: rendition.primaries || null,
        bitDepth: Number(rendition.bit_depth || 0) || null,
        isDefault: parseBoolean(rendition.is_default, false)
      }))
    : [];
  const hlgRendition = renditions.find((rendition) => rendition.kind === "hlg");
  return {
    id: photo.id,
    albumId: directusRelationId(photo.album_id),
    sdrImage: directusFileId(photo.sdr_image),
    hdrImage: directusFileId(photo.hdr_image),
    caption: photo.caption || "",
    altText: photo.alt_text || "",
    hdrTransfer: photo.hdr_transfer || null,
    hdrPrimaries: photo.hdr_primaries || null,
    hdrBitDepth: photo.hdr_bit_depth ?? null,
    hlgImage: hlgRendition?.file || null,
    filmScanFrameId: directusRelationId(photo.film_scan_frame_id),
    filmStock: photo.film_stock || null,
    filmProcess: photo.film_process || null,
    filmScanner: photo.film_scanner || null,
    filmFrameFormat: photo.film_frame_format || null,
    renditions,
    published: parseBoolean(photo.published, false),
    sortOrder: Number(photo.sort_order || 0),
    createdAt: photo.created_at || null,
    updatedAt: photo.updated_at || null
  };
}

async function createAlbumPhotoWithReconciliation(
  token,
  albumId,
  sdrFileId,
  payload,
  uploadKey
) {
  try {
    const response = await directusRequest("/items/album_photos", token, {
      method: "POST",
      body: payload
    });
    if (response.data?.id) {
      return response.data;
    }

    const error = httpError(
      502,
      `Directus did not return the saved photo "${uploadKey}".`
    );
    error.directusAmbiguous = true;
    throw error;
  } catch (error) {
    if (error.directusAmbiguous) {
      try {
        const reconciledPhoto = await findAlbumPhotoBySdrFile(
          token,
          albumId,
          sdrFileId
        );
        if (reconciledPhoto) {
          return reconciledPhoto;
        }
      } catch (reconciliationError) {
        error.reconciliationError = reconciliationError;
      }
    }
    throw error;
  }
}

async function handleAlbumPhotoUpload(req, res, albumId) {
  let parsed = null;
  let token = null;
  const batchId = crypto.randomUUID();
  const createdPhotoIds = [];
  const uploadedFileIds = [];
  const reconciliationTags = [];

  try {
    parsed = await parseAlbumMultipart(req);
    const uploads = await validateAlbumUpload(parsed);
    token = await directusLogin();
    const album = await getAlbumById(token, albumId);
    const existingPhotos = await listAlbumPhotos(token, albumId);
    const maxSortOrder = existingPhotos.reduce(
      (maximum, photo) =>
        Math.max(maximum, Number.parseInt(photo.sort_order, 10) || 0),
      -1
    );
    const now = new Date().toISOString();
    const createdPhotos = [];

    for (let index = 0; index < uploads.length; index += 1) {
      const upload = uploads[index];
      const sdrUploadTag = albumUploadTag(batchId, index, "sdr");
      reconciliationTags.push(sdrUploadTag);
      const sdrFileId = await directusUploadFile(
        token,
        upload.sdr,
        upload.caption || upload.altText || upload.sdr.originalName,
        { reconciliationTag: sdrUploadTag }
      );
      uploadedFileIds.push(sdrFileId);

      let hdrFileId = null;
      if (upload.hdr) {
        const hdrUploadTag = albumUploadTag(batchId, index, "hdr");
        reconciliationTags.push(hdrUploadTag);
        hdrFileId = await directusUploadFile(
          token,
          upload.hdr,
          `${upload.caption || upload.altText || upload.hdr.originalName} HDR`,
          { reconciliationTag: hdrUploadTag }
        );
        uploadedFileIds.push(hdrFileId);
      }

      const savedPhoto = await createAlbumPhotoWithReconciliation(
        token,
        albumId,
        sdrFileId,
        {
          album_id: Number(albumId),
          sdr_image: sdrFileId,
          hdr_image: hdrFileId,
          caption: upload.caption,
          alt_text: upload.altText,
          hdr_transfer: upload.hdrMetadata?.transfer || null,
          hdr_primaries: upload.hdrMetadata?.primaries || null,
          hdr_bit_depth: upload.hdrMetadata?.bitDepth || null,
          published: upload.published,
          sort_order: maxSortOrder + index + 1,
          created_at: now,
          updated_at: now
        },
        upload.key
      );
      createdPhotoIds.push(savedPhoto.id);
      createdPhotos.push(savedPhoto);
    }

    if (!directusFileId(album.cover_image)) {
      const firstPublished = createdPhotos.find((photo) =>
        parseBoolean(photo.published, false)
      );
      if (firstPublished) {
        await directusRequest(
          `/items/albums/${encodeURIComponent(albumId)}`,
          token,
          {
            method: "PATCH",
            body: {
              cover_image: directusFileId(firstPublished.sdr_image),
              updated_at: new Date().toISOString()
            }
          }
        );
      }
    }

    sendJson(res, 201, {
      status: "ok",
      albumId: Number(albumId),
      photos: createdPhotos.map(serializeManagedPhoto)
    });
  } catch (error) {
    if (
      token &&
      (createdPhotoIds.length ||
        uploadedFileIds.length ||
        reconciliationTags.length)
    ) {
      const cleanupFailures = await rollbackAlbumUpload(
        token,
        albumId,
        createdPhotoIds,
        uploadedFileIds,
        reconciliationTags
      );
      if (cleanupFailures.length) {
        error.cleanupFailures = cleanupFailures;
      }
    }
    throw error;
  } finally {
    if (parsed?.tempDir) {
      await fsp
        .rm(parsed.tempDir, { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

function pickAlbumPhotoPatch(body) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "caption")) {
    patch.caption = normalizeAlbumText(body.caption, "caption", 2000);
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "altText") ||
    Object.prototype.hasOwnProperty.call(body, "alt_text")
  ) {
    patch.alt_text = normalizeAlbumText(
      body.altText ?? body.alt_text,
      "altText",
      500
    );
  }
  if (Object.prototype.hasOwnProperty.call(body, "published")) {
    patch.published = parseAlbumBoolean(
      body.published,
      false,
      "photo published"
    );
  }
  if (!Object.keys(patch).length) {
    throw httpError(400, "No editable photo fields were provided.");
  }
  return patch;
}

function firstPublishedCoverPhoto(photos, excludedPhotoId = null) {
  return photos.find(
    (photo) =>
      String(photo.id) !== String(excludedPhotoId ?? "") &&
      parseBoolean(photo.published, false) &&
      directusFileId(photo.sdr_image)
  ) || null;
}

async function setAlbumCoverFile(token, albumId, fileId) {
  await directusRequest(
    `/items/albums/${encodeURIComponent(albumId)}`,
    token,
    {
      method: "PATCH",
      body: {
        cover_image: fileId || null,
        updated_at: new Date().toISOString()
      }
    }
  );
}

async function handleAlbumPhotoPatch(req, res, albumId, photoId) {
  const body = await readJsonBody(req);
  const patch = pickAlbumPhotoPatch(body);
  const token = await directusLogin();
  const [album, photo] = await Promise.all([
    getAlbumById(token, albumId),
    getAlbumPhoto(token, albumId, photoId)
  ]);
  const wasPublished = parseBoolean(photo.published, false);
  const nextPublished =
    Object.prototype.hasOwnProperty.call(patch, "published")
      ? patch.published
      : wasPublished;

  const response = await directusRequest(
    `/items/album_photos/${encodeURIComponent(photoId)}`,
    token,
    {
      method: "PATCH",
      body: { ...patch, updated_at: new Date().toISOString() }
    }
  );

  try {
    const currentCover = directusFileId(album.cover_image);
    const photoSdr = directusFileId(photo.sdr_image);
    if (!nextPublished && currentCover === photoSdr) {
      const photos = await listAlbumPhotos(token, albumId);
      const replacement = firstPublishedCoverPhoto(photos, photoId);
      await setAlbumCoverFile(
        token,
        albumId,
        directusFileId(replacement?.sdr_image)
      );
    } else if (nextPublished && !currentCover) {
      await setAlbumCoverFile(token, albumId, photoSdr);
    }
  } catch (error) {
    if (
      Object.prototype.hasOwnProperty.call(patch, "published") &&
      patch.published !== wasPublished
    ) {
      await directusRequest(
        `/items/album_photos/${encodeURIComponent(photoId)}`,
        token,
        {
          method: "PATCH",
          body: {
            published: wasPublished,
            updated_at: new Date().toISOString()
          }
        }
      ).catch((rollbackError) => {
        console.error(
          `[albums] Could not roll back photo ${photoId} publication state: ${rollbackError.message}`
        );
      });
    }
    throw error;
  }

  sendJson(res, 200, {
    status: "ok",
    photo: serializeManagedPhoto({ ...photo, ...response.data })
  });
}

async function handleAlbumPhotoHdrUpload(req, res, albumId, photoId) {
  let parsed = null;
  let token = null;
  let uploadedHdrFileId = null;
  let hdrCommitted = false;
  let preserveUploadedFile = false;

  try {
    parsed = await parseAlbumMultipart(req);
    if (parsed.files.sdrFiles.length) {
      throw httpError(
        400,
        "Manual HDR upload accepts only one HDR AVIF file."
      );
    }
    if (parsed.files.hdrFiles.length !== 1) {
      throw httpError(
        400,
        "Manual HDR upload requires exactly one HDR AVIF file."
      );
    }

    const hdrUpload = parsed.files.hdrFiles[0];
    try {
      validateAlbumBatchLimits([], [hdrUpload], {
        maxPhotos: 1,
        maxFileBytes: MAX_ALBUM_IMAGE_BYTES,
        maxBatchBytes: MAX_ALBUM_IMAGE_BYTES
      });
    } catch (error) {
      throw httpError(413, error.message);
    }

    let hdrMetadata;
    try {
      hdrMetadata = validateHdrProbe(
        await probeAlbumImage(hdrUpload.tempPath)
      );
    } catch (error) {
      throw httpError(422, `HDR photo failed validation: ${error.message}`);
    }

    token = await directusLogin();
    const photo = await getAlbumPhoto(token, albumId, photoId);
    const sdrFileId = directusFileId(photo.sdr_image);
    if (!sdrFileId) {
      throw httpError(422, "The selected photo does not have an SDR image.");
    }

    const sdrValidationPath = path.join(
      parsed.tempDir,
      `existing-sdr-${photoId}`
    );
    assertInside(parsed.tempDir, sdrValidationPath);
    await downloadDirectusAssetToFile(
      token,
      sdrFileId,
      sdrValidationPath
    );
    try {
      const sdrMetadata = validateSdrProbe(
        await probeAlbumImage(sdrValidationPath)
      );
      validatePairedAspectRatio(sdrMetadata, hdrMetadata);
    } catch (error) {
      throw httpError(
        422,
        `HDR photo does not match the selected SDR photo: ${error.message}`
      );
    }

    const reconciliationTag =
      `album-hdr:${albumId}:${photoId}:${crypto.randomUUID()}`;
    uploadedHdrFileId = await directusUploadFile(
      token,
      hdrUpload,
      `${photo.caption || photo.alt_text || hdrUpload.originalName} HDR`,
      { reconciliationTag }
    );

    const renditionKind = hdrMetadata.transfer;
    const existingRendition = Array.isArray(photo.renditions)
      ? photo.renditions.find((rendition) => rendition.kind === renditionKind)
      : null;
    const patch =
      renditionKind === "pq"
        ? {
            hdr_image: uploadedHdrFileId,
            hdr_transfer: hdrMetadata.transfer,
            hdr_primaries: hdrMetadata.primaries,
            hdr_bit_depth: hdrMetadata.bitDepth,
            updated_at: new Date().toISOString()
          }
        : { updated_at: new Date().toISOString() };
    let savedPhoto;
    try {
      const response = await directusRequest(
        `/items/album_photos/${encodeURIComponent(photoId)}`,
        token,
        {
          method: "PATCH",
          body: patch
        }
      );
      savedPhoto = { ...photo, ...response.data };
    } catch (error) {
      if (!error.directusAmbiguous) {
        throw error;
      }
      preserveUploadedFile = true;
      const reconciledPhoto = await getAlbumPhoto(token, albumId, photoId);
      if (
        renditionKind === "pq" &&
        String(directusFileId(reconciledPhoto.hdr_image)) !==
        String(uploadedHdrFileId)
      ) {
        throw error;
      }
      savedPhoto = reconciledPhoto;
    }
    const renditionPayload = {
      photo_id: Number(photoId),
      film_scan_frame_id: directusRelationId(photo.film_scan_frame_id),
      kind: renditionKind,
      file: uploadedHdrFileId,
      transfer: hdrMetadata.transfer,
      primaries: hdrMetadata.primaries,
      bit_depth: hdrMetadata.bitDepth,
      is_default: renditionKind === "pq" || !directusFileId(photo.hdr_image),
      created_at: existingRendition?.created_at || new Date().toISOString()
    };
    try {
      if (existingRendition?.id) {
        await directusRequest(
          `/items/album_photo_renditions/${existingRendition.id}`,
          token,
          { method: "PATCH", body: renditionPayload }
        );
      } else {
        await directusRequest("/items/album_photo_renditions", token, {
          method: "POST",
          body: renditionPayload
        });
      }
    } catch (error) {
      if (renditionKind === "pq") {
        await directusRequest(`/items/album_photos/${photoId}`, token, {
          method: "PATCH",
          body: {
            hdr_image: directusFileId(photo.hdr_image),
            hdr_transfer: photo.hdr_transfer,
            hdr_primaries: photo.hdr_primaries,
            hdr_bit_depth: photo.hdr_bit_depth,
            updated_at: new Date().toISOString()
          }
        }).catch(() => {});
      }
      throw error;
    }
    savedPhoto = await getAlbumPhoto(token, albumId, photoId);
    hdrCommitted = true;

    const previousHdrFileId =
      directusFileId(existingRendition?.file) ||
      (renditionKind === "pq" ? directusFileId(photo.hdr_image) : null);
    let cleanupFailure = null;
    if (
      previousHdrFileId &&
      String(previousHdrFileId) !== String(uploadedHdrFileId)
    ) {
      cleanupFailure = await deleteDirectusFileSafely(
        token,
        previousHdrFileId,
        "replaced HDR photo"
      );
    }

    sendJson(res, cleanupFailure ? 202 : 200, {
      status: cleanupFailure ? "partial" : "ok",
      photo: serializeManagedPhoto(savedPhoto),
      cleanupRequired: Boolean(cleanupFailure),
      orphanFileIds: cleanupFailure ? [cleanupFailure.fileId] : []
    });
  } catch (error) {
    if (
      token &&
      uploadedHdrFileId &&
      !hdrCommitted &&
      !preserveUploadedFile
    ) {
      await deleteDirectusFileSafely(
        token,
        uploadedHdrFileId,
        "uncommitted manual HDR upload"
      );
    }
    throw error;
  } finally {
    if (parsed?.tempDir) {
      await fsp
        .rm(parsed.tempDir, { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

async function handleAlbumPhotoDelete(res, albumId, photoId) {
  const token = await directusLogin();
  const [album, photo, photos] = await Promise.all([
    getAlbumById(token, albumId),
    getAlbumPhoto(token, albumId, photoId),
    listAlbumPhotos(token, albumId)
  ]);
  const originalCover = directusFileId(album.cover_image);
  const photoSdr = directusFileId(photo.sdr_image);
  let coverChanged = false;

  if (originalCover === photoSdr) {
    const replacement = firstPublishedCoverPhoto(photos, photoId);
    await setAlbumCoverFile(
      token,
      albumId,
      directusFileId(replacement?.sdr_image)
    );
    coverChanged = true;
  }

  try {
    await directusRequest(
      `/items/album_photos/${encodeURIComponent(photoId)}`,
      token,
      { method: "DELETE" }
    );
  } catch (error) {
    if (coverChanged) {
      await setAlbumCoverFile(token, albumId, originalCover).catch(
        (rollbackError) => {
          console.error(
            `[albums] Could not restore album ${albumId} cover: ${rollbackError.message}`
          );
        }
      );
    }
    throw error;
  }

  const fileIds = [
    ...new Set(
      [
        directusFileId(photo.hdr_image),
        directusFileId(photo.sdr_image),
        ...(Array.isArray(photo.renditions)
          ? photo.renditions.map((rendition) => directusFileId(rendition.file))
          : [])
      ].filter(Boolean)
    )
  ];
  const cleanupFailures = [];
  for (const fileId of fileIds) {
    const failure = await deleteDirectusFileSafely(
      token,
      fileId,
      "photo file"
    );
    if (failure) {
      cleanupFailures.push(failure);
    }
  }

  if (cleanupFailures.length) {
    sendJson(res, 202, {
      status: "partial",
      deletedPhotoId: Number(photoId),
      cleanupRequired: true,
      orphanFileIds: cleanupFailures.map((failure) => failure.fileId),
      message:
        "The photo record was deleted, but one or more image files require manual cleanup."
    });
    return;
  }

  sendJson(res, 200, {
    status: "ok",
    deletedPhotoId: Number(photoId),
    cleanupRequired: false,
    orphanFileIds: []
  });
}

function normalizeReorderIds(value) {
  if (!Array.isArray(value)) {
    throw httpError(400, "photoIds must be an array.");
  }

  const ids = value.map((id) => normalizeAlbumId(id, "photo id"));
  if (new Set(ids).size !== ids.length) {
    throw httpError(400, "photoIds must not contain duplicates.");
  }
  return ids;
}

async function handleAlbumPhotoReorder(req, res, albumId) {
  const body = await readJsonBody(req, 256 * 1024);
  const orderedIds = normalizeReorderIds(body.photoIds);
  const token = await directusLogin();
  await getAlbumById(token, albumId);
  const photos = await listAlbumPhotos(token, albumId);
  const existingIds = photos.map((photo) => String(photo.id));

  if (
    orderedIds.length !== existingIds.length ||
    orderedIds.some((id) => !existingIds.includes(id))
  ) {
    throw httpError(
      400,
      "photoIds must contain every photo in this album exactly once."
    );
  }

  const originalOrder = new Map(
    photos.map((photo) => [String(photo.id), Number(photo.sort_order || 0)])
  );
  const updatedIds = [];
  try {
    for (let index = 0; index < orderedIds.length; index += 1) {
      const photoId = orderedIds[index];
      await directusRequest(
        `/items/album_photos/${encodeURIComponent(photoId)}`,
        token,
        {
          method: "PATCH",
          body: {
            sort_order: index,
            updated_at: new Date().toISOString()
          }
        }
      );
      updatedIds.push(photoId);
    }
  } catch (error) {
    for (const photoId of updatedIds.reverse()) {
      await directusRequest(
        `/items/album_photos/${encodeURIComponent(photoId)}`,
        token,
        {
          method: "PATCH",
          body: {
            sort_order: originalOrder.get(photoId),
            updated_at: new Date().toISOString()
          }
        }
      ).catch((rollbackError) => {
        console.error(
          `[albums] Could not restore photo ${photoId} order: ${rollbackError.message}`
        );
      });
    }
    throw error;
  }

  sendJson(res, 200, {
    status: "ok",
    albumId: Number(albumId),
    photoIds: orderedIds.map(Number)
  });
}

async function handleAlbumCover(req, res, albumId) {
  const body = await readJsonBody(req);
  const photoId = normalizeAlbumId(body.photoId, "photo id");
  const token = await directusLogin();
  await getAlbumById(token, albumId);
  const photo = await getAlbumPhoto(token, albumId, photoId);
  if (!parseBoolean(photo.published, false)) {
    throw httpError(400, "Only a published photo can be used as the album cover.");
  }
  const sdrFileId = directusFileId(photo.sdr_image);
  if (!sdrFileId) {
    throw httpError(422, "The selected photo does not have an SDR image.");
  }

  await setAlbumCoverFile(token, albumId, sdrFileId);
  sendJson(res, 200, {
    status: "ok",
    albumId: Number(albumId),
    coverPhotoId: Number(photoId),
    coverImage: sdrFileId
  });
}

const FILM_SCAN_JOB_FIELDS = [
  "id",
  "album_id",
  "status",
  "scanner",
  "frame_format",
  "film_type",
  "film_stock",
  "iso",
  "process",
  "push_pull",
  "roll_adjustments",
  "progress",
  "warnings",
  "error_message",
  "experimental_compatibility",
  "started_at",
  "completed_at",
  "created_at",
  "updated_at"
].join(",");

const FILM_SCAN_SOURCE_FIELDS = [
  "id",
  "job_id",
  "original_name",
  "relative_path",
  "format",
  "mime_type",
  "size_bytes",
  "sha256",
  "width",
  "height",
  "bit_depth",
  "icc_description",
  "has_icc",
  "decode_status",
  "decode_error",
  "created_at",
  "updated_at"
].join(",");

const FILM_SCAN_FRAME_FIELDS = [
  "id",
  "job_id",
  "source_id",
  "album_photo_id",
  "crop_x",
  "crop_y",
  "crop_width",
  "crop_height",
  "rotation",
  "sort_order",
  "confidence",
  "review_status",
  "accepted",
  "published",
  "adjustment_overrides",
  "preview_path",
  "created_at",
  "updated_at"
].join(",");

const filmScanQueue = [];
let activeFilmScanJobId = null;
const filmScanJobControllers = new Map();
let filmScanPreviewTail = Promise.resolve();

function enqueueFilmScanPreview(operation) {
  const result = filmScanPreviewTail.then(operation, operation);
  filmScanPreviewTail = result.catch(() => {});
  return result;
}

function filmScanCanceledError(message = "胶片扫描任务已取消。") {
  const error = httpError(409, message);
  error.filmScanCanceled = true;
  return error;
}

function filmScanTimeoutError(label) {
  const error = httpError(504, `${label}处理超时。`);
  error.filmScanTimedOut = true;
  return error;
}

function throwIfFilmScanAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || filmScanCanceledError();
  }
}

function registerFilmScanController(jobId) {
  const key = String(jobId);
  if (filmScanJobControllers.has(key)) {
    throw httpError(409, `胶片扫描任务 ${jobId} 正在处理中。`);
  }
  const controller = new AbortController();
  filmScanJobControllers.set(key, controller);
  return controller;
}

function releaseFilmScanController(jobId, controller) {
  const key = String(jobId);
  if (filmScanJobControllers.get(key) === controller) {
    filmScanJobControllers.delete(key);
  }
}

function jsonObject(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function serializeFilmScanSource(source) {
  return {
    id: Number(source.id),
    jobId: Number(directusRelationId(source.job_id)),
    originalName: source.original_name,
    format: source.format,
    mimeType: source.mime_type,
    sizeBytes: Number(source.size_bytes || 0),
    sha256: source.sha256,
    width: Number(source.width || 0) || null,
    height: Number(source.height || 0) || null,
    bitDepth: Number(source.bit_depth || 0) || null,
    hasIcc: parseBoolean(source.has_icc, false),
    iccDescription: source.icc_description || null,
    decodeStatus: source.decode_status,
    decodeError: source.decode_error || null
  };
}

function serializeFilmScanFrame(frame) {
  return {
    id: Number(frame.id),
    jobId: Number(directusRelationId(frame.job_id)),
    sourceId: Number(directusRelationId(frame.source_id)),
    albumPhotoId: directusRelationId(frame.album_photo_id)
      ? Number(directusRelationId(frame.album_photo_id))
      : null,
    crop: normalizeCrop({
      x: Number(frame.crop_x),
      y: Number(frame.crop_y),
      width: Number(frame.crop_width),
      height: Number(frame.crop_height)
    }),
    rotation: Number(frame.rotation || 0),
    sortOrder: Number(frame.sort_order || 0),
    confidence: Number(frame.confidence || 0),
    reviewStatus: frame.review_status || "pending",
    accepted: parseBoolean(frame.accepted, true),
    published: parseBoolean(frame.published, true),
    adjustmentOverrides: jsonObject(frame.adjustment_overrides),
    previewAvailable: Boolean(frame.preview_path)
  };
}

function serializeFilmScanJob(job, sources = [], frames = []) {
  return {
    id: Number(job.id),
    albumId: Number(directusRelationId(job.album_id)),
    status: job.status,
    scanner: job.scanner,
    frameFormat: job.frame_format,
    filmType: job.film_type,
    filmStock: job.film_stock,
    iso: Number(job.iso || 0),
    process: job.process,
    pushPull: Number(job.push_pull || 0),
    rollAdjustments: normalizeAdjustments(jsonObject(job.roll_adjustments)),
    progress: Number(job.progress || 0),
    warnings: jsonArray(job.warnings),
    error: job.error_message || null,
    experimentalCompatibility: parseBoolean(job.experimental_compatibility, true),
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    createdAt: job.created_at || null,
    updatedAt: job.updated_at || null,
    sources: sources.map(serializeFilmScanSource),
    frames: [...frames]
      .sort(
        (left, right) =>
          Number(left.sort_order || 0) - Number(right.sort_order || 0) ||
          Number(left.id) - Number(right.id)
      )
      .map(serializeFilmScanFrame)
  };
}

async function getFilmScanJobRecord(token, albumId, jobId) {
  let job;
  try {
    const response = await directusRequest(
      `/items/film_scan_jobs/${encodeURIComponent(jobId)}?fields=${encodeURIComponent(
        FILM_SCAN_JOB_FIELDS
      )}`,
      token
    );
    job = response.data;
  } catch (error) {
    if ((error.directusHttpStatus || error.statusCode) === 404) {
      throw httpError(404, `胶片扫描任务 ${jobId} 不存在。`);
    }
    throw error;
  }
  if (String(directusRelationId(job.album_id)) !== String(albumId)) {
    throw httpError(404, `胶片扫描任务 ${jobId} 不属于相簿 ${albumId}。`);
  }
  return job;
}

async function listFilmScanSources(token, jobId) {
  const params = new URLSearchParams({
    "filter[job_id][_eq]": String(jobId),
    fields: FILM_SCAN_SOURCE_FIELDS,
    sort: "id",
    limit: "-1"
  });
  const result = await directusRequest(
    `/items/film_scan_sources?${params.toString()}`,
    token
  );
  return Array.isArray(result.data) ? result.data : [];
}

async function listFilmScanFrames(token, jobId) {
  const params = new URLSearchParams({
    "filter[job_id][_eq]": String(jobId),
    fields: FILM_SCAN_FRAME_FIELDS,
    sort: "sort_order,id",
    limit: "-1"
  });
  const result = await directusRequest(
    `/items/film_scan_frames?${params.toString()}`,
    token
  );
  return Array.isArray(result.data) ? result.data : [];
}

async function getFilmScanFrameRecord(token, albumId, jobId, frameId) {
  const job = await getFilmScanJobRecord(token, albumId, jobId);
  const frames = await listFilmScanFrames(token, jobId);
  const frame = frames.find((candidate) => String(candidate.id) === String(frameId));
  if (!frame) throw httpError(404, `任务中不存在帧 ${frameId}。`);
  return { job, frame };
}

async function handleFilmStockPresets(req, res) {
  const token = await directusLogin();
  if (req.method === "GET") {
    const params = new URLSearchParams({
      fields:
        "id,manufacturer,model,film_type,nominal_iso,recommended_process,scanner,parameters,built_in,created_at,updated_at",
      sort: "-built_in,manufacturer,model",
      limit: "-1"
    });
    const result = await directusRequest(
      `/items/film_stock_presets?${params.toString()}`,
      token
    );
    sendJson(res, 200, {
      status: "ok",
      presets: Array.isArray(result.data) ? result.data : []
    });
    return;
  }
  const body = await readJsonBody(req, 256 * 1024);
  const manufacturer = normalizeAlbumText(
    body.manufacturer,
    "manufacturer",
    100,
    { required: true }
  );
  const model = normalizeAlbumText(body.model, "model", 160, { required: true });
  const filmType = String(body.filmType || "").trim();
  if (!["color-negative", "bw-negative", "slide"].includes(filmType)) {
    throw httpError(400, "filmType 无效。");
  }
  const scanner = body.scanner ? String(body.scanner).trim() : null;
  if (
    scanner &&
    !["hasselblad-x5", "fujifilm-sp3000", "noritsu-hs1800"].includes(scanner)
  ) {
    throw httpError(400, "scanner 无效。");
  }
  const nominalIso = Math.max(1, Math.min(25600, Number(body.nominalIso || 100)));
  const recommendedProcess = String(body.recommendedProcess || "").trim();
  if (
    recommendedProcess &&
    !["c41", "e6", "ecn2", "bw", "other"].includes(recommendedProcess)
  ) {
    throw httpError(400, "recommendedProcess 无效。");
  }
  const existingParams = new URLSearchParams({
    "filter[manufacturer][_eq]": manufacturer,
    "filter[model][_eq]": model,
    "filter[built_in][_eq]": "false",
    fields: "id",
    limit: "1"
  });
  const existing = (
    await directusRequest(
      `/items/film_stock_presets?${existingParams.toString()}`,
      token
    )
  ).data?.[0];
  const payload = {
    manufacturer,
    model,
    film_type: filmType,
    nominal_iso: nominalIso,
    recommended_process: recommendedProcess || null,
    scanner,
    parameters: normalizeAdjustments(jsonObject(body.parameters)),
    built_in: false,
    updated_at: new Date().toISOString()
  };
  const saved = existing
    ? (
        await directusRequest(`/items/film_stock_presets/${existing.id}`, token, {
          method: "PATCH",
          body: payload
        })
      ).data
    : (
        await directusRequest("/items/film_stock_presets", token, {
          method: "POST",
          body: { ...payload, created_at: new Date().toISOString() }
        })
      ).data;
  sendJson(res, existing ? 200 : 201, { status: "ok", preset: saved });
}

function filmScanSourcePath(relativePath) {
  const filePath = path.resolve(MEDIA_ROOT, String(relativePath || ""));
  assertInside(FILM_SCAN_ROOT, filePath);
  return filePath;
}

function filmScanFrameCrop(frame) {
  return normalizeCrop({
    x: Number(frame.crop_x),
    y: Number(frame.crop_y),
    width: Number(frame.crop_width),
    height: Number(frame.crop_height)
  });
}

async function updateFilmScanJob(token, jobId, patch) {
  return (
    await directusRequest(`/items/film_scan_jobs/${encodeURIComponent(jobId)}`, token, {
      method: "PATCH",
      body: { ...patch, updated_at: new Date().toISOString() }
    })
  ).data;
}

function enqueueFilmScanJob(jobId) {
  const normalized = String(jobId);
  if (
    normalized === String(activeFilmScanJobId) ||
    filmScanQueue.some((queued) => String(queued) === normalized)
  ) {
    return;
  }
  filmScanQueue.push(normalized);
  void drainFilmScanQueue();
}

async function withFilmScanTimeout(operation, label, controller) {
  let timeout;
  const work = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => {
            const error = filmScanTimeoutError(label);
            controller.abort(error);
            reject(error);
          },
          FILM_SCAN_PROCESS_TIMEOUT_MS
        );
      })
    ]);
  } catch (error) {
    if (error.filmScanTimedOut) {
      await work.catch(() => {});
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function drainFilmScanQueue() {
  if (activeFilmScanJobId || !filmScanQueue.length) return;
  activeFilmScanJobId = filmScanQueue.shift();
  const jobId = activeFilmScanJobId;
  let controller;
  try {
    controller = registerFilmScanController(jobId);
    await withFilmScanTimeout(
      (signal) => analyzeFilmScanJob(jobId, signal),
      `胶片扫描任务 ${jobId}`,
      controller
    );
  } catch (error) {
    console.error(`[film-scan] Job ${jobId} failed: ${error.stack || error.message}`);
    try {
      const token = await directusLogin();
      const current = (
        await directusRequest(`/items/film_scan_jobs/${jobId}?fields=status`, token)
      ).data;
      if (error.filmScanCanceled) {
        await updateFilmScanJob(token, jobId, {
          status: "canceled",
          error_message: null
        });
      } else if (current?.status !== "canceled") {
        await updateFilmScanJob(token, jobId, {
          status: "failed",
          error_message: error.message
        });
      }
    } catch (updateError) {
      console.error(
        `[film-scan] Could not persist failure for ${jobId}: ${updateError.message}`
      );
    }
  } finally {
    if (controller) releaseFilmScanController(jobId, controller);
    activeFilmScanJobId = null;
    if (filmScanQueue.length) setImmediate(() => void drainFilmScanQueue());
  }
}

async function analyzeFilmScanJob(jobId, signal) {
  throwIfFilmScanAborted(signal);
  const token = await directusLogin();
  const response = await directusRequest(
    `/items/film_scan_jobs/${encodeURIComponent(jobId)}?fields=${encodeURIComponent(
      FILM_SCAN_JOB_FIELDS
    )}`,
    token
  );
  const job = response.data;
  if (!job || ["canceled", "committed"].includes(job.status)) return;
  throwIfFilmScanAborted(signal);
  await updateFilmScanJob(token, jobId, {
    status: "analyzing",
    progress: 1,
    error_message: null,
    started_at: job.started_at || new Date().toISOString()
  });

  const existingFrames = await listFilmScanFrames(token, jobId);
  for (const frame of existingFrames) {
    throwIfFilmScanAborted(signal);
    await directusRequest(`/items/film_scan_frames/${frame.id}`, token, {
      method: "DELETE"
    });
  }
  const sources = await listFilmScanSources(token, jobId);
  const warnings = [];
  let order = 0;
  let rollMask = null;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    throwIfFilmScanAborted(signal);
    const currentJob = (
      await directusRequest(`/items/film_scan_jobs/${jobId}?fields=status`, token)
    ).data;
    if (currentJob.status === "canceled") return;

    const source = sources[sourceIndex];
    const sourcePath = filmScanSourcePath(source.relative_path);
    try {
      const metadata = await inspectFilmScanSource(sourcePath);
      throwIfFilmScanAborted(signal);
      await directusRequest(`/items/film_scan_sources/${source.id}`, token, {
        method: "PATCH",
        body: {
          width: metadata.width,
          height: metadata.height,
          bit_depth: metadata.bitDepth,
          has_icc: metadata.hasIcc,
          icc_description: metadata.hasIcc
            ? `${metadata.space || "embedded"} ICC (${metadata.iccBytes} bytes)`
            : null,
          decode_status: "decoded",
          decode_error: null,
          updated_at: new Date().toISOString()
        }
      });
      if (source.format === "fff") {
        warnings.push(
          `${source.original_name} 以增强 TIFF 方式解码；X5 FFF/3F 兼容仍为实验性。`
        );
      }
      const analysis = await createAnalysisImage(sourcePath);
      throwIfFilmScanAborted(signal);
      const detections = detectFilmFrames(analysis, {
        frameFormat: job.frame_format
      });
      const sourceDir = path.dirname(sourcePath);
      const previewDir = path.join(sourceDir, "previews");
      await fsp.mkdir(previewDir, { recursive: true });
      await renderFilmSourceContact(
        sourcePath,
        path.join(previewDir, `source-${source.id}-contact.jpg`)
      );
      throwIfFilmScanAborted(signal);

      for (const detection of detections) {
        throwIfFilmScanAborted(signal);
        const base = estimateFilmBase(analysis, detection.crop);
        if (
          !rollMask &&
          job.film_type === "color-negative" &&
          base.confidence >= 0.85
        ) {
          rollMask = base.rgb;
        }
        const frameCreated = (
          await directusRequest("/items/film_scan_frames", token, {
            method: "POST",
            body: {
              job_id: Number(jobId),
              source_id: Number(source.id),
              crop_x: detection.crop.x,
              crop_y: detection.crop.y,
              crop_width: detection.crop.width,
              crop_height: detection.crop.height,
              rotation: 0,
              sort_order: order,
              confidence: detection.confidence,
              review_status: detection.requiresConfirmation
                ? "confirmation_required"
                : "auto",
              accepted: true,
              published: true,
              adjustment_overrides: {},
              preview_path: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          })
        ).data;
        const previewPath = path.join(previewDir, `${frameCreated.id}.jpg`);
        const adjustments = normalizeAdjustments(jsonObject(job.roll_adjustments));
        await renderReviewedFilmFrame({
          sourcePath,
          outputPath: previewPath,
          crop: detection.crop,
          rotation: 0,
          filmType: job.film_type,
          adjustments,
          maskRgb: adjustments.maskRgb || rollMask || base.rgb,
          tempDir: previewDir,
          key: `preview-${frameCreated.id}`,
          maximumDimension: 1400,
          quality: 88,
          signal
        });
        throwIfFilmScanAborted(signal);
        const previewRelative = path.relative(MEDIA_ROOT, previewPath);
        await directusRequest(`/items/film_scan_frames/${frameCreated.id}`, token, {
          method: "PATCH",
          body: {
            preview_path: previewRelative,
            updated_at: new Date().toISOString()
          }
        });
        if (detection.requiresConfirmation) {
          warnings.push(
            `帧 ${order + 1} 的自动裁切置信度为 ${detection.confidence.toFixed(
              2
            )}，提交前必须手动确认。`
          );
        }
        order += 1;
      }
    } catch (error) {
      if (signal?.aborted || error.filmScanCanceled || error.filmScanTimedOut) {
        throw signal?.reason || error;
      }
      await directusRequest(`/items/film_scan_sources/${source.id}`, token, {
        method: "PATCH",
        body: {
          decode_status: "failed",
          decode_error: error.message,
          updated_at: new Date().toISOString()
        }
      });
      throw new Error(`原档“${source.original_name}”解码失败：${error.message}`);
    }

    await updateFilmScanJob(token, jobId, {
      progress: Math.round(((sourceIndex + 1) / sources.length) * 85)
    });
  }

  if (!order) throw new Error("未能从原档中识别出任何帧。");
  throwIfFilmScanAborted(signal);
  const adjustments = normalizeAdjustments(jsonObject(job.roll_adjustments));
  if (job.film_type === "color-negative" && adjustments.maskMode === "auto") {
    adjustments.maskRgb = rollMask;
    if (!rollMask) {
      adjustments.maskMode = "preset";
      adjustments.maskRgb = await findFilmStockPresetMask(token, job);
      warnings.push(
        adjustments.maskRgb
          ? "未找到可靠片基区域，已回退到扫描仪与胶卷型号预设，并标记为低置信度。"
          : "未找到可靠片基区域或匹配预设，已使用通用彩负基准并标记为低置信度。"
      );
    }
  }
  throwIfFilmScanAborted(signal);
  const finalState = (
    await directusRequest(`/items/film_scan_jobs/${jobId}?fields=status`, token)
  ).data?.status;
  if (finalState === "canceled") throw filmScanCanceledError();
  throwIfFilmScanAborted(signal);
  await updateFilmScanJob(token, jobId, {
    status: "review_required",
    progress: 100,
    roll_adjustments: adjustments,
    warnings
  });
  throwIfFilmScanAborted(signal);
}

async function findFilmStockPresetMask(token, job) {
  const params = new URLSearchParams({
    fields: "manufacturer,model,scanner,parameters,built_in",
    limit: "-1"
  });
  const presets = (
    await directusRequest(`/items/film_stock_presets?${params.toString()}`, token)
  ).data;
  const requested = String(job.film_stock || "").trim().toLowerCase();
  const matches = (Array.isArray(presets) ? presets : []).filter((preset) => {
    const fullName = `${preset.manufacturer || ""} ${preset.model || ""}`
      .trim()
      .toLowerCase();
    return fullName === requested || String(preset.model || "").toLowerCase() === requested;
  });
  const selected =
    matches.find((preset) => preset.scanner === job.scanner) ||
    matches.find((preset) => !preset.scanner) ||
    null;
  const maskRgb = jsonObject(selected?.parameters).maskRgb;
  return Array.isArray(maskRgb) && maskRgb.length === 3
    ? maskRgb.map((channel) => Math.max(0, Math.min(1, Number(channel))))
    : null;
}

async function handleFilmScanCreate(req, res, albumId) {
  let parsed;
  let token;
  let job = null;
  let finalDir = null;
  try {
    parsed = await parseFilmScanMultipart(req);
    let rawMetadata;
    try {
      rawMetadata = JSON.parse(parsed.fields.metadata);
    } catch {
      throw httpError(400, "metadata 必须是有效 JSON。");
    }
    let metadata;
    try {
      metadata = normalizeFilmScanMetadata(rawMetadata);
    } catch (error) {
      throw httpError(400, error.message);
    }
    const unsupportedSource = parsed.files.find((file) => {
      if (metadata.scanner === "hasselblad-x5") return file.format === "jpeg";
      return file.format === "fff";
    });
    if (unsupportedSource) {
      throw httpError(
        415,
        metadata.scanner === "hasselblad-x5"
          ? `Hasselblad X5 原档“${unsupportedSource.originalName}”应使用 FFF/3F 或 TIFF。`
          : `FFF/3F 仅用于 Hasselblad X5；“${unsupportedSource.originalName}”请改用 TIFF 或 JPEG。`
      );
    }
    token = await directusLogin();
    await getAlbumById(token, albumId);

    const duplicateParams = new URLSearchParams({
      "filter[sha256][_in]": parsed.files.map((file) => file.sha256).join(","),
      fields: "id,original_name,sha256",
      limit: "1"
    });
    const duplicate = (
      await directusRequest(
        `/items/film_scan_sources?${duplicateParams.toString()}`,
        token
      )
    ).data?.[0];
    if (duplicate) {
      throw httpError(
        409,
        `原档与已导入的“${duplicate.original_name}”内容重复（SHA-256 相同）。`
      );
    }

    const now = new Date().toISOString();
    job = (
      await directusRequest("/items/film_scan_jobs", token, {
        method: "POST",
        body: {
          album_id: Number(albumId),
          status: "uploaded",
          scanner: metadata.scanner,
          frame_format: metadata.frameFormat,
          film_type: metadata.filmType,
          film_stock: metadata.filmStock,
          iso: metadata.iso,
          process: metadata.process,
          push_pull: metadata.pushPull,
          roll_adjustments: metadata.adjustments,
          progress: 0,
          warnings: [],
          error_message: null,
          experimental_compatibility: true,
          created_at: now,
          updated_at: now
        }
      })
    ).data;

    finalDir = path.join(FILM_SCAN_ROOT, String(job.id));
    assertInside(FILM_SCAN_ROOT, finalDir);
    const sourceDir = path.join(finalDir, "sources");
    await fsp.mkdir(sourceDir, { recursive: true });
    const createdSources = [];
    for (const file of parsed.files) {
      const targetPath = path.join(sourceDir, file.filename);
      assertInside(finalDir, targetPath);
      await fsp.rename(file.tempPath, targetPath);
      const relativePath = path.relative(MEDIA_ROOT, targetPath);
      const source = (
        await directusRequest("/items/film_scan_sources", token, {
          method: "POST",
          body: {
            job_id: Number(job.id),
            original_name: file.originalName,
            relative_path: relativePath,
            format: file.format,
            mime_type: file.mimeType,
            size_bytes: file.size,
            sha256: file.sha256,
            decode_status: "queued",
            created_at: now,
            updated_at: now
          }
        })
      ).data;
      createdSources.push(source);
    }

    const responseJob = serializeFilmScanJob(job, createdSources, []);
    sendJson(res, 202, { status: "ok", job: responseJob });
    enqueueFilmScanJob(job.id);
  } catch (error) {
    if (job?.id && token) {
      await updateFilmScanJob(token, job.id, {
        status: "failed",
        error_message: error.message
      }).catch(() => {});
    }
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        status: "error",
        error: error.message,
        preservedJobId: job?.id || null
      });
    }
  } finally {
    if (parsed?.tempDir) {
      await fsp.rm(parsed.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function handleFilmScanGet(res, albumId, jobId) {
  const token = await directusLogin();
  const job = await getFilmScanJobRecord(token, albumId, jobId);
  const [sources, frames] = await Promise.all([
    listFilmScanSources(token, jobId),
    listFilmScanFrames(token, jobId)
  ]);
  sendJson(res, 200, {
    status: "ok",
    job: serializeFilmScanJob(job, sources, frames)
  });
}

function pickFilmScanJobPatch(body) {
  const patch = {};
  if (Object.hasOwn(body, "rollAdjustments")) {
    patch.roll_adjustments = normalizeAdjustments(body.rollAdjustments);
  }
  if (Object.hasOwn(body, "filmStock")) {
    const filmStock = String(body.filmStock || "").trim();
    if (!filmStock) throw httpError(400, "胶卷型号不能为空。");
    patch.film_stock = filmStock.slice(0, 160);
  }
  if (Object.hasOwn(body, "iso")) patch.iso = Math.max(1, Math.min(25600, Number(body.iso)));
  if (Object.hasOwn(body, "pushPull")) {
    patch.push_pull = Math.max(-5, Math.min(5, Number(body.pushPull)));
  }
  return patch;
}

async function renderOpticalDensityNegative(inputPath, outputPath, maskRgb, signal) {
  throwIfFilmScanAborted(signal);
  const mask =
    Array.isArray(maskRgb) && maskRgb.length === 3
      ? maskRgb.map((channel) =>
          Math.max(0.01, Math.min(1, Number(channel)))
        )
      : [0.82, 0.61, 0.39];
  const linearMask = mask.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  );
  const densityRange = (2.4 * Math.log(10)).toFixed(6);
  const channelExpression = (channel, sample) =>
    `clip(log(${channel.toFixed(6)}/max(${sample}(X,Y),0.000015))/${densityRange},0,1)`;
  const filter = [
    "setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709",
    "zscale=transfer=linear:npl=100",
    "format=gbrpf32le",
    [
      `geq=r='${channelExpression(linearMask[0], "r")}'`,
      `g='${channelExpression(linearMask[1], "g")}'`,
      `b='${channelExpression(linearMask[2], "b")}'`
    ].join(":"),
    "format=gbrp16le"
  ].join(",");
  await runProcess(
    FFMPEG_PATH,
    [
      "-y",
      "-v",
      "error",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      filter,
      "-c:v",
      "tiff",
      "-pix_fmt",
      "rgb48le",
      outputPath
    ],
    { timeoutMs: FILM_SCAN_PROCESS_TIMEOUT_MS, signal }
  );
}

async function prepareFilmFrameForRendering(options) {
  if (options.filmType !== "color-negative") {
    return {
      sourcePath: options.sourcePath,
      crop: options.crop,
      rotation: options.rotation,
      filmType: options.filmType,
      temporaryPaths: []
    };
  }
  const key = options.key || crypto.randomUUID();
  const rawPath = path.join(options.tempDir, `${key}-managed-raw.tif`);
  const densityPath = path.join(options.tempDir, `${key}-density.tif`);
  assertInside(options.tempDir, rawPath);
  assertInside(options.tempDir, densityPath);
  await fsp.mkdir(options.tempDir, { recursive: true });
  await renderFilmRawFrame({
    sourcePath: options.sourcePath,
    outputPath: rawPath,
    crop: options.crop,
    rotation: options.rotation
  });
  throwIfFilmScanAborted(options.signal);
  await renderOpticalDensityNegative(
    rawPath,
    densityPath,
    options.adjustments?.maskRgb,
    options.signal
  );
  return {
    sourcePath: densityPath,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    filmType: "slide",
    temporaryPaths: [rawPath, densityPath]
  };
}

async function renderReviewedFilmFrame(options) {
  const adjustments = normalizeAdjustments({
    ...options.adjustments,
    maskRgb: options.maskRgb || options.adjustments?.maskRgb || null
  });
  const prepared = await prepareFilmFrameForRendering({
    sourcePath: options.sourcePath,
    crop: options.crop,
    rotation: options.rotation,
    filmType: options.filmType,
    adjustments,
    tempDir: options.tempDir || path.dirname(options.outputPath),
    key: options.key,
    signal: options.signal
  });
  try {
    throwIfFilmScanAborted(options.signal);
    return await renderFilmFrame({
      ...options,
      sourcePath: prepared.sourcePath,
      crop: prepared.crop,
      rotation: prepared.rotation,
      filmType: prepared.filmType,
      adjustments
    });
  } finally {
    for (const temporaryPath of prepared.temporaryPaths) {
      await fsp.unlink(temporaryPath).catch(() => {});
    }
  }
}

async function renderFilmScanFramePreviewNow(token, job, frame) {
  const sources = await listFilmScanSources(token, job.id);
  const source = sources.find(
    (candidate) => String(candidate.id) === String(directusRelationId(frame.source_id))
  );
  if (!source) throw httpError(404, "帧对应的原档不存在。");
  const previewPath = filmScanSourcePath(frame.preview_path);
  await fsp.mkdir(path.dirname(previewPath), { recursive: true });
  const roll = normalizeAdjustments(jsonObject(job.roll_adjustments));
  const adjustments = mergeFrameAdjustments(
    roll,
    jsonObject(frame.adjustment_overrides)
  );
  await renderReviewedFilmFrame({
    sourcePath: filmScanSourcePath(source.relative_path),
    outputPath: previewPath,
    crop: filmScanFrameCrop(frame),
    rotation: Number(frame.rotation || 0),
    filmType: job.film_type,
    adjustments,
    maskRgb: adjustments.maskRgb,
    tempDir: path.dirname(previewPath),
    key: `preview-${frame.id}`,
    maximumDimension: 1400,
    quality: 88
  });
}

function rerenderFilmScanFrame(token, job, frame) {
  return enqueueFilmScanPreview(() =>
    renderFilmScanFramePreviewNow(token, job, frame)
  );
}

async function handleFilmScanJobPatch(req, res, albumId, jobId) {
  const body = await readJsonBody(req, 512 * 1024);
  const token = await directusLogin();
  const job = await getFilmScanJobRecord(token, albumId, jobId);
  if (!["review_required", "failed"].includes(job.status)) {
    throw httpError(409, "仅待审核或失败任务可修改整卷参数。");
  }
  const patch = pickFilmScanJobPatch(body);
  if (!Object.keys(patch).length && !Array.isArray(body.frameOrder)) {
    throw httpError(400, "未提供可修改的任务字段。");
  }
  if (Array.isArray(body.frameOrder)) {
    const frames = await listFilmScanFrames(token, jobId);
    const expected = new Set(frames.map((frame) => String(frame.id)));
    const received = body.frameOrder.map(String);
    if (
      received.length !== expected.size ||
      new Set(received).size !== received.length ||
      received.some((id) => !expected.has(id))
    ) {
      throw httpError(400, "frameOrder 必须完整且不能重复。");
    }
    for (let index = 0; index < received.length; index += 1) {
      await directusRequest(`/items/film_scan_frames/${received[index]}`, token, {
        method: "PATCH",
        body: { sort_order: index, updated_at: new Date().toISOString() }
      });
    }
  }
  const sample = patch.roll_adjustments?.filmBaseSample;
  if (sample && patch.roll_adjustments.maskMode === "manual") {
    const sources = await listFilmScanSources(token, jobId);
    const source =
      sources.find(
        (candidate) => String(candidate.id) === String(sample.sourceId || "")
      ) || sources[0];
    if (!source) throw httpError(409, "任务中没有可供片基取样的原档。");
    patch.roll_adjustments.maskRgb = await sampleFilmBaseAtPoint(
      filmScanSourcePath(source.relative_path),
      sample
    );
    patch.roll_adjustments.filmBaseSample = {
      x: sample.x,
      y: sample.y,
      sourceId: Number(source.id)
    };
  }
  if (Object.keys(patch).length) await updateFilmScanJob(token, jobId, patch);
  const currentJob = await getFilmScanJobRecord(token, albumId, jobId);
  const [sources, frames] = await Promise.all([
    listFilmScanSources(token, jobId),
    listFilmScanFrames(token, jobId)
  ]);
  sendJson(res, 200, {
    status: "ok",
    job: serializeFilmScanJob(currentJob, sources, frames)
  });
}

async function handleFilmScanFramePatch(req, res, albumId, jobId, frameId) {
  const body = await readJsonBody(req, 512 * 1024);
  const token = await directusLogin();
  const { job, frame } = await getFilmScanFrameRecord(
    token,
    albumId,
    jobId,
    frameId
  );
  if (job.status !== "review_required") {
    throw httpError(409, "仅待审核任务可修改帧。");
  }
  if (body.action === "split") {
    const sources = await listFilmScanSources(token, jobId);
    const source = sources.find(
      (candidate) =>
        String(candidate.id) === String(directusRelationId(frame.source_id))
    );
    if (!source) throw httpError(404, "帧对应的原档不存在。");
    const crop = filmScanFrameCrop(frame);
    const horizontal =
      crop.width * Number(source.width || 1) >=
      crop.height * Number(source.height || 1);
    const splitAt = Math.max(0.15, Math.min(0.85, Number(body.splitAt || 0.5)));
    const firstCrop = horizontal
      ? { ...crop, width: crop.width * splitAt }
      : { ...crop, height: crop.height * splitAt };
    const secondCrop = horizontal
      ? {
          ...crop,
          x: crop.x + crop.width * splitAt,
          width: crop.width * (1 - splitAt)
        }
      : {
          ...crop,
          y: crop.y + crop.height * splitAt,
          height: crop.height * (1 - splitAt)
        };
    const frames = await listFilmScanFrames(token, jobId);
    for (const candidate of frames.filter(
      (candidate) => Number(candidate.sort_order) > Number(frame.sort_order)
    )) {
      await directusRequest(`/items/film_scan_frames/${candidate.id}`, token, {
        method: "PATCH",
        body: {
          sort_order: Number(candidate.sort_order) + 1,
          updated_at: new Date().toISOString()
        }
      });
    }
    const updated = (
      await directusRequest(`/items/film_scan_frames/${frameId}`, token, {
        method: "PATCH",
        body: {
          crop_x: firstCrop.x,
          crop_y: firstCrop.y,
          crop_width: firstCrop.width,
          crop_height: firstCrop.height,
          review_status: "confirmation_required",
          updated_at: new Date().toISOString()
        }
      })
    ).data;
    const created = (
      await directusRequest("/items/film_scan_frames", token, {
        method: "POST",
        body: {
          job_id: Number(jobId),
          source_id: Number(directusRelationId(frame.source_id)),
          crop_x: secondCrop.x,
          crop_y: secondCrop.y,
          crop_width: secondCrop.width,
          crop_height: secondCrop.height,
          rotation: Number(frame.rotation || 0),
          sort_order: Number(frame.sort_order) + 1,
          confidence: Math.min(0.84, Number(frame.confidence || 0.5)),
          review_status: "confirmation_required",
          accepted: true,
          published: parseBoolean(frame.published, true),
          adjustment_overrides: jsonObject(frame.adjustment_overrides),
          preview_path: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      })
    ).data;
    const previewRelative = path.join(
      path.dirname(String(frame.preview_path)),
      `${created.id}.jpg`
    );
    const createdWithPreview = (
      await directusRequest(`/items/film_scan_frames/${created.id}`, token, {
        method: "PATCH",
        body: { preview_path: previewRelative, updated_at: new Date().toISOString() }
      })
    ).data;
    await Promise.all([
      rerenderFilmScanFrame(token, job, { ...frame, ...updated }),
      rerenderFilmScanFrame(token, job, { ...created, ...createdWithPreview })
    ]);
    sendJson(res, 201, {
      status: "ok",
      frames: [
        serializeFilmScanFrame({ ...frame, ...updated }),
        serializeFilmScanFrame({ ...created, ...createdWithPreview })
      ]
    });
    return;
  }
  if (body.action === "merge-next") {
    const frames = await listFilmScanFrames(token, jobId);
    const currentIndex = frames.findIndex(
      (candidate) => String(candidate.id) === String(frameId)
    );
    const next = frames[currentIndex + 1];
    if (!next) throw httpError(409, "当前帧后没有可合并的帧。");
    if (
      String(directusRelationId(next.source_id)) !==
      String(directusRelationId(frame.source_id))
    ) {
      throw httpError(409, "只能合并同一原档中的相邻帧。");
    }
    const left = filmScanFrameCrop(frame);
    const right = filmScanFrameCrop(next);
    const x = Math.min(left.x, right.x);
    const y = Math.min(left.y, right.y);
    const crop = normalizeCrop({
      x,
      y,
      width: Math.max(left.x + left.width, right.x + right.width) - x,
      height: Math.max(left.y + left.height, right.y + right.height) - y
    });
    const updated = (
      await directusRequest(`/items/film_scan_frames/${frameId}`, token, {
        method: "PATCH",
        body: {
          crop_x: crop.x,
          crop_y: crop.y,
          crop_width: crop.width,
          crop_height: crop.height,
          confidence: Math.min(0.84, Number(frame.confidence || 0.5)),
          review_status: "confirmation_required",
          updated_at: new Date().toISOString()
        }
      })
    ).data;
    await directusRequest(`/items/film_scan_frames/${next.id}`, token, {
      method: "DELETE"
    });
    if (next.preview_path) {
      await fsp.unlink(filmScanSourcePath(next.preview_path)).catch(() => {});
    }
    for (let index = currentIndex + 2; index < frames.length; index += 1) {
      await directusRequest(`/items/film_scan_frames/${frames[index].id}`, token, {
        method: "PATCH",
        body: {
          sort_order: index - 1,
          updated_at: new Date().toISOString()
        }
      });
    }
    await rerenderFilmScanFrame(token, job, { ...frame, ...updated });
    sendJson(res, 200, {
      status: "ok",
      frame: serializeFilmScanFrame({ ...frame, ...updated }),
      removedFrameId: Number(next.id)
    });
    return;
  }
  const patch = {};
  if (body.crop) {
    const crop = normalizeCrop(body.crop);
    Object.assign(patch, {
      crop_x: crop.x,
      crop_y: crop.y,
      crop_width: crop.width,
      crop_height: crop.height
    });
  }
  if (Object.hasOwn(body, "rotation")) {
    const rotation = Number(body.rotation);
    if (![0, 90, 180, 270].includes(rotation)) {
      throw httpError(400, "旋转角度只能是 0、90、180 或 270。");
    }
    patch.rotation = rotation;
  }
  if (Object.hasOwn(body, "accepted")) patch.accepted = parseAlbumBoolean(body.accepted, true);
  if (Object.hasOwn(body, "published")) patch.published = parseAlbumBoolean(body.published, true);
  if (Object.hasOwn(body, "adjustmentOverrides")) {
    patch.adjustment_overrides = jsonObject(body.adjustmentOverrides);
  }
  if (Object.hasOwn(body, "confirmed") && parseAlbumBoolean(body.confirmed, false)) {
    patch.review_status = "confirmed";
  }
  if (!Object.keys(patch).length) throw httpError(400, "未提供可修改的帧字段。");
  const updated = (
    await directusRequest(`/items/film_scan_frames/${frameId}`, token, {
      method: "PATCH",
      body: { ...patch, updated_at: new Date().toISOString() }
    })
  ).data;
  await rerenderFilmScanFrame(token, job, { ...frame, ...updated });
  sendJson(res, 200, {
    status: "ok",
    frame: serializeFilmScanFrame({ ...frame, ...updated })
  });
}

async function handleFilmScanPreview(req, res, albumId, jobId) {
  const body = await readJsonBody(req, 64 * 1024);
  const frameId = normalizeAlbumId(body.frameId, "frame id");
  const token = await directusLogin();
  const { job, frame } = await getFilmScanFrameRecord(
    token,
    albumId,
    jobId,
    frameId
  );
  await rerenderFilmScanFrame(token, job, frame);
  sendJson(res, 200, {
    status: "ok",
    frameId: Number(frameId),
    previewEndpoint: `/api/albums/${albumId}/film-scans/${jobId}/frames/${frameId}/preview`
  });
}

async function handleFilmScanPreviewAsset(res, albumId, jobId, frameId) {
  const token = await directusLogin();
  const { frame } = await getFilmScanFrameRecord(
    token,
    albumId,
    jobId,
    frameId
  );
  if (!frame.preview_path) throw httpError(404, "该帧尚无审核预览。");
  const previewPath = filmScanSourcePath(frame.preview_path);
  const stat = await fsp.stat(previewPath);
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": stat.size,
    "Cache-Control": "private, no-store"
  });
  fs.createReadStream(previewPath).pipe(res);
}

async function handleFilmScanSourcePreviewAsset(
  res,
  albumId,
  jobId,
  sourceId
) {
  const token = await directusLogin();
  await getFilmScanJobRecord(token, albumId, jobId);
  const sources = await listFilmScanSources(token, jobId);
  const source = sources.find((candidate) => String(candidate.id) === String(sourceId));
  if (!source) throw httpError(404, "任务中不存在该原档。");
  const previewPath = path.join(
    path.dirname(filmScanSourcePath(source.relative_path)),
    "previews",
    `source-${source.id}-contact.jpg`
  );
  assertInside(FILM_SCAN_ROOT, previewPath);
  const stat = await fsp.stat(previewPath);
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": stat.size,
    "Cache-Control": "private, no-store"
  });
  fs.createReadStream(previewPath).pipe(res);
}

async function renderFilmHdrRendition(
  inputPath,
  outputPath,
  kind,
  signal,
  highlightRolloff = 0.25
) {
  throwIfFilmScanAborted(signal);
  const transfer = kind === "pq" ? "smpte2084" : "arib-std-b67";
  const rolloff = Math.max(0, Math.min(1, Number(highlightRolloff || 0)));
  const shoulder = 0.68 + rolloff * 0.17;
  const shoulderOutput = 0.43 + rolloff * 0.09;
  const filter = [
    "setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709",
    `curves=all='0/0 0.5/0.35 ${shoulder.toFixed(4)}/${shoulderOutput.toFixed(
      4
    )} 0.92/0.78 1/1'`,
    "zscale=transfer=linear:npl=1000",
    "format=gbrpf32le",
    `zscale=primaries=bt2020:transfer=${transfer}:matrix=bt2020nc:npl=1000`,
    "format=yuv444p10le"
  ].join(",");
  await runProcess(
    FFMPEG_PATH,
    [
      "-y",
      "-v",
      "error",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      filter,
      "-c:v",
      "libaom-av1",
      "-still-picture",
      "1",
      "-cpu-used",
      "4",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv444p10le",
      "-color_primaries",
      "bt2020",
      "-color_trc",
      transfer,
      "-colorspace",
      "bt2020nc",
      "-f",
      "avif",
      outputPath
    ],
    { timeoutMs: FILM_SCAN_PROCESS_TIMEOUT_MS, signal }
  );
  throwIfFilmScanAborted(signal);
  const probe = await probeAlbumImage(outputPath);
  const pixelFormat = String(probe.pix_fmt || "");
  const bitDepth = Number(probe.bits_per_raw_sample || (pixelFormat.match(/10/) ? 10 : 0));
  if (
    !pixelFormat.includes("10") ||
    bitDepth < 10 ||
    String(probe.color_primaries || "") !== "bt2020" ||
    String(probe.color_transfer || "") !== transfer
  ) {
    throw new Error(`${kind.toUpperCase()} AVIF 的 FFprobe 色彩标记校验失败。`);
  }
  return {
    transfer: kind,
    primaries: "bt2020",
    bitDepth: 10,
    probe
  };
}

async function handleFilmScanCommit(req, res, albumId, jobId) {
  const body = await readJsonBody(req, 64 * 1024);
  const token = await directusLogin();
  let job = await getFilmScanJobRecord(token, albumId, jobId);
  if (job.status !== "review_required") {
    throw httpError(409, "仅待审核任务可以提交。");
  }
  const frames = (await listFilmScanFrames(token, jobId)).filter((frame) =>
    parseBoolean(frame.accepted, true)
  );
  if (!frames.length) throw httpError(400, "请至少保留一帧再提交。");
  const unconfirmed = frames.find(
    (frame) =>
      Number(frame.confidence || 0) < 0.85 && frame.review_status !== "confirmed"
  );
  if (unconfirmed) {
    throw httpError(409, `帧 ${unconfirmed.id} 的低置信度裁切尚未手动确认。`);
  }
  const publishDefault = parseAlbumBoolean(body.published, true);
  const sources = await listFilmScanSources(token, jobId);
  const sourceById = new Map(sources.map((source) => [String(source.id), source]));
  const existingPhotos = await listAlbumPhotos(token, albumId);
  const maxSortOrder = existingPhotos.reduce(
    (maximum, photo) => Math.max(maximum, Number(photo.sort_order || 0)),
    -1
  );
  const workDir = path.join(FILM_SCAN_ROOT, String(jobId), "render");
  await fsp.mkdir(workDir, { recursive: true });

  const createdPhotoIds = [];
  const createdRenditionIds = [];
  const uploadedFileIds = [];
  const warnings = jsonArray(job.warnings);
  const analysisBySource = new Map();
  const controller = registerFilmScanController(jobId);
  try {
    const signal = controller.signal;
    throwIfFilmScanAborted(signal);
    const stateBeforeRendering = (
      await directusRequest(`/items/film_scan_jobs/${jobId}?fields=status`, token)
    ).data?.status;
    if (stateBeforeRendering === "canceled") throw filmScanCanceledError();
    if (stateBeforeRendering !== "review_required") {
      throw httpError(409, "任务状态已变化，请刷新后重试。");
    }
    throwIfFilmScanAborted(signal);
    await updateFilmScanJob(token, jobId, {
      status: "rendering",
      progress: 0,
      error_message: null
    });
    throwIfFilmScanAborted(signal);
    for (let index = 0; index < frames.length; index += 1) {
      throwIfFilmScanAborted(signal);
      const currentState = (
        await directusRequest(`/items/film_scan_jobs/${jobId}?fields=status`, token)
      ).data?.status;
      if (currentState === "canceled") {
        throw filmScanCanceledError();
      }
      const frame = frames[index];
      const source = sourceById.get(String(directusRelationId(frame.source_id)));
      if (!source) throw new Error(`帧 ${frame.id} 的原档不存在。`);
      const adjustments = mergeFrameAdjustments(
        jsonObject(job.roll_adjustments),
        jsonObject(frame.adjustment_overrides)
      );
      const prefix = `frame-${String(index + 1).padStart(3, "0")}`;
      const sdrPath = path.join(workDir, `${prefix}-sdr.jpg`);
      const linearPath = path.join(workDir, `${prefix}-linear.tif`);
      const prepared = await prepareFilmFrameForRendering({
        sourcePath: filmScanSourcePath(source.relative_path),
        crop: filmScanFrameCrop(frame),
        rotation: Number(frame.rotation || 0),
        filmType: job.film_type,
        adjustments,
        tempDir: workDir,
        key: prefix,
        signal
      });
      let dynamicRange = null;
      if (Number(source.bit_depth || 0) >= 16) {
        const sourceKey = String(source.id);
        if (!analysisBySource.has(sourceKey)) {
          analysisBySource.set(
            sourceKey,
            await createAnalysisImage(filmScanSourcePath(source.relative_path))
          );
        }
        dynamicRange = assessFilmFrameDynamicRange(
          analysisBySource.get(sourceKey),
          filmScanFrameCrop(frame)
        );
      }
      const canRenderHdr =
        Number(source.bit_depth || 0) >= 16 && Boolean(dynamicRange?.eligible);
      let pqPath = null;
      let hlgPath = null;
      let pqMetadata = null;
      let hlgMetadata = null;
      try {
        await renderFilmFrame({
          sourcePath: prepared.sourcePath,
          outputPath: sdrPath,
          crop: prepared.crop,
          rotation: prepared.rotation,
          filmType: prepared.filmType,
          adjustments,
          maskRgb: adjustments.maskRgb,
          outputFormat: "jpeg",
          quality: 94
        });
        throwIfFilmScanAborted(signal);
        if (canRenderHdr) {
          await renderFilmFrame({
            sourcePath: prepared.sourcePath,
            outputPath: linearPath,
            crop: prepared.crop,
            rotation: prepared.rotation,
            filmType: prepared.filmType,
            adjustments,
            maskRgb: adjustments.maskRgb,
            outputFormat: "tiff16"
          });
          throwIfFilmScanAborted(signal);
          pqPath = path.join(workDir, `${prefix}-pq.avif`);
          hlgPath = path.join(workDir, `${prefix}-hlg.avif`);
          try {
            pqMetadata = await renderFilmHdrRendition(
              linearPath,
              pqPath,
              "pq",
              signal,
              adjustments.highlightRolloff
            );
          } catch (error) {
            pqPath = null;
            warnings.push(`帧 ${index + 1} 的 PQ 渲染失败：${error.message}`);
          }
          try {
            hlgMetadata = await renderFilmHdrRendition(
              linearPath,
              hlgPath,
              "hlg",
              signal,
              adjustments.highlightRolloff
            );
          } catch (error) {
            hlgPath = null;
            warnings.push(`帧 ${index + 1} 的 HLG 渲染失败：${error.message}`);
          }
        } else if (Number(source.bit_depth || 0) < 16) {
          warnings.push(`帧 ${index + 1} 来源为 8-bit，仅生成 SDR，未伪造 HDR。`);
        } else {
          warnings.push(
            `帧 ${index + 1} 的有效动态范围不足（${Number(
              dynamicRange?.effectiveStops || 0
            ).toFixed(1)} stops），仅生成 SDR。`
          );
        }
      } finally {
        for (const temporaryPath of prepared.temporaryPaths) {
          await fsp.unlink(temporaryPath).catch(() => {});
        }
      }

      const title = `${job.film_stock} ${prefix}`;
      const sdrFileId = await directusUploadFile(
        token,
        {
          tempPath: sdrPath,
          filename: `${prefix}.jpg`,
          mimeType: "image/jpeg"
        },
        title
      );
      uploadedFileIds.push(sdrFileId);
      let pqFileId = null;
      let hlgFileId = null;
      if (pqPath) {
        pqFileId = await directusUploadFile(
          token,
          {
            tempPath: pqPath,
            filename: `${prefix}-pq.avif`,
            mimeType: "image/avif"
          },
          `${title} PQ`
        );
        uploadedFileIds.push(pqFileId);
      }
      if (hlgPath) {
        hlgFileId = await directusUploadFile(
          token,
          {
            tempPath: hlgPath,
            filename: `${prefix}-hlg.avif`,
            mimeType: "image/avif"
          },
          `${title} HLG`
        );
        uploadedFileIds.push(hlgFileId);
      }

      const now = new Date().toISOString();
      const published = Object.hasOwn(body, "published")
        ? publishDefault
        : parseBoolean(frame.published, true);
      const photo = (
        await directusRequest("/items/album_photos", token, {
          method: "POST",
          body: {
            album_id: Number(albumId),
            sdr_image: sdrFileId,
            hdr_image: pqFileId,
            caption: `${job.film_stock} · ${job.process.toUpperCase()}`,
            alt_text: `${job.film_stock} 胶片扫描`,
            hdr_transfer: pqFileId ? "pq" : null,
            hdr_primaries: pqFileId ? "bt2020" : null,
            hdr_bit_depth: pqFileId ? 10 : null,
            film_scan_frame_id: Number(frame.id),
            film_stock: job.film_stock,
            film_process: job.process,
            film_scanner: job.scanner,
            film_frame_format: job.frame_format,
            published,
            sort_order: maxSortOrder + index + 1,
            created_at: now,
            updated_at: now
          }
        })
      ).data;
      createdPhotoIds.push(photo.id);
      const renditions = [
        {
          kind: "sdr",
          file: sdrFileId,
          transfer: "srgb",
          primaries: "bt709",
          bitDepth: 8,
          isDefault: true
        },
        pqFileId
          ? {
              kind: "pq",
              file: pqFileId,
              transfer: pqMetadata.transfer,
              primaries: pqMetadata.primaries,
              bitDepth: pqMetadata.bitDepth,
              isDefault: true
            }
          : null,
        hlgFileId
          ? {
              kind: "hlg",
              file: hlgFileId,
              transfer: hlgMetadata.transfer,
              primaries: hlgMetadata.primaries,
              bitDepth: hlgMetadata.bitDepth,
              isDefault: !pqFileId
            }
          : null
      ].filter(Boolean);
      for (const rendition of renditions) {
        const created = (
          await directusRequest("/items/album_photo_renditions", token, {
            method: "POST",
            body: {
              photo_id: Number(photo.id),
              film_scan_frame_id: Number(frame.id),
              kind: rendition.kind,
              file: rendition.file,
              transfer: rendition.transfer,
              primaries: rendition.primaries,
              bit_depth: rendition.bitDepth,
              is_default: rendition.isDefault,
              created_at: now
            }
          })
        ).data;
        createdRenditionIds.push(created.id);
      }
      await directusRequest(`/items/film_scan_frames/${frame.id}`, token, {
        method: "PATCH",
        body: {
          album_photo_id: Number(photo.id),
          review_status: "committed",
          updated_at: now
        }
      });
      await updateFilmScanJob(token, jobId, {
        progress: Math.round(((index + 1) / frames.length) * 100),
        warnings
      });
    }

    throwIfFilmScanAborted(signal);
    const stateBeforeCommit = (
      await directusRequest(`/items/film_scan_jobs/${jobId}?fields=status`, token)
    ).data?.status;
    if (stateBeforeCommit === "canceled") throw filmScanCanceledError();
    throwIfFilmScanAborted(signal);
    const album = await getAlbumById(token, albumId);
    if (!directusFileId(album.cover_image) && createdPhotoIds[0]) {
      const first = await getAlbumPhoto(token, albumId, createdPhotoIds[0]);
      await directusRequest(`/items/albums/${albumId}`, token, {
        method: "PATCH",
        body: {
          cover_image: directusFileId(first.sdr_image),
          updated_at: new Date().toISOString()
        }
      });
    }
    throwIfFilmScanAborted(signal);
    job = await updateFilmScanJob(token, jobId, {
      status: "committed",
      progress: 100,
      warnings,
      completed_at: new Date().toISOString()
    });
    throwIfFilmScanAborted(signal);
    sendJson(res, 201, {
      status: "ok",
      job: serializeFilmScanJob(job, sources, await listFilmScanFrames(token, jobId)),
      createdPhotoIds: createdPhotoIds.map(Number)
    });
  } catch (error) {
    for (const renditionId of [...createdRenditionIds].reverse()) {
      await directusRequest(`/items/album_photo_renditions/${renditionId}`, token, {
        method: "DELETE"
      }).catch(() => {});
    }
    for (const photoId of [...createdPhotoIds].reverse()) {
      await directusRequest(`/items/album_photos/${photoId}`, token, {
        method: "DELETE"
      }).catch(() => {});
    }
    for (const fileId of [...uploadedFileIds].reverse()) {
      await directusRequest(`/files/${fileId}`, token, { method: "DELETE" }).catch(
        () => {}
      );
    }
    await updateFilmScanJob(
      token,
      jobId,
      error.filmScanCanceled
        ? { status: "canceled", error_message: null, warnings }
        : { status: "failed", error_message: error.message, warnings }
    ).catch(() => {});
    throw error;
  } finally {
    releaseFilmScanController(jobId, controller);
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleFilmScanRetry(res, albumId, jobId) {
  const token = await directusLogin();
  const job = await getFilmScanJobRecord(token, albumId, jobId);
  if (job.status !== "failed") throw httpError(409, "仅失败任务可以重试。");
  const [sources, frames] = await Promise.all([
    listFilmScanSources(token, jobId),
    listFilmScanFrames(token, jobId)
  ]);
  await cleanupFilmScanPartialCommit(token, job, frames);
  const canResumeReview =
    frames.length > 0 &&
    sources.length > 0 &&
    sources.every((source) => source.decode_status === "decoded");
  if (canResumeReview) {
    await updateFilmScanJob(token, jobId, {
      status: "review_required",
      progress: 100,
      error_message: null
    });
    sendJson(res, 200, {
      status: "ok",
      jobId: Number(jobId),
      resumedAt: "review_required"
    });
    return;
  }
  await updateFilmScanJob(token, jobId, {
    status: "uploaded",
    progress: 0,
    error_message: null
  });
  enqueueFilmScanJob(jobId);
  sendJson(res, 202, { status: "ok", jobId: Number(jobId) });
}

async function cleanupFilmScanPartialCommit(token, job, providedFrames = null) {
  const frames = providedFrames || (await listFilmScanFrames(token, job.id));
  if (!frames.length) return;
  const frameIds = frames.map((frame) => String(frame.id));
  const params = new URLSearchParams({
    "filter[film_scan_frame_id][_in]": frameIds.join(","),
    fields: ALBUM_PHOTO_FIELDS,
    limit: "-1"
  });
  const photos = (
    await directusRequest(`/items/album_photos?${params.toString()}`, token)
  ).data;
  for (const photo of Array.isArray(photos) ? photos : []) {
    const fileIds = [
      ...new Set(
        [
          directusFileId(photo.sdr_image),
          directusFileId(photo.hdr_image),
          ...(Array.isArray(photo.renditions)
            ? photo.renditions.map((rendition) => directusFileId(rendition.file))
            : [])
        ].filter(Boolean)
      )
    ];
    await directusRequest(`/items/album_photos/${photo.id}`, token, {
      method: "DELETE"
    }).catch(() => {});
    for (const fileId of fileIds) {
      await deleteDirectusFileSafely(
        token,
        fileId,
        `partial film-scan job ${job.id}`
      );
    }
  }
  for (const frame of frames.filter((candidate) =>
    directusRelationId(candidate.album_photo_id)
  )) {
    await directusRequest(`/items/film_scan_frames/${frame.id}`, token, {
      method: "PATCH",
      body: {
        album_photo_id: null,
        review_status:
          Number(frame.confidence || 0) < 0.85 ? "confirmed" : "auto",
        updated_at: new Date().toISOString()
      }
    }).catch(() => {});
  }
}

async function handleFilmScanCancel(res, albumId, jobId) {
  const token = await directusLogin();
  const job = await getFilmScanJobRecord(token, albumId, jobId);
  if (["committed", "canceled"].includes(job.status)) {
      throw httpError(409, "已提交或已取消任务不能再次取消。");
  }
  const controller = filmScanJobControllers.get(String(jobId));
  if (controller && !controller.signal.aborted) {
    controller.abort(filmScanCanceledError());
  }
  await updateFilmScanJob(token, jobId, {
    status: "canceled",
    error_message: null
  });
  const index = filmScanQueue.findIndex((queued) => String(queued) === String(jobId));
  if (index >= 0) filmScanQueue.splice(index, 1);
  sendJson(res, 200, { status: "ok", jobId: Number(jobId), state: "canceled" });
}

async function recoverFilmScanQueue() {
  try {
    await fsp.mkdir(FILM_SCAN_ROOT, { recursive: true });
    const token = await directusLogin();
    const params = new URLSearchParams({
      "filter[status][_in]": "uploaded,analyzing,rendering",
      fields: "id,status",
      sort: "created_at,id",
      limit: "-1"
    });
    const jobs = (
      await directusRequest(`/items/film_scan_jobs?${params.toString()}`, token)
    ).data;
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (job.status === "rendering") {
        const fullJob = (
          await directusRequest(
            `/items/film_scan_jobs/${job.id}?fields=${encodeURIComponent(
              FILM_SCAN_JOB_FIELDS
            )}`,
            token
          )
        ).data;
        await cleanupFilmScanPartialCommit(token, fullJob);
        await updateFilmScanJob(token, job.id, {
          status: "review_required",
          progress: 100,
          error_message: "API 重启中断了成片生成；已回滚部分提交，请重新审核并提交。"
        });
        continue;
      }
      if (job.status === "analyzing") {
        await updateFilmScanJob(token, job.id, { status: "uploaded", progress: 0 });
      }
      enqueueFilmScanJob(job.id);
    }
  } catch (error) {
    console.error(`[film-scan] Queue recovery skipped: ${error.message}`);
  }
}

async function handleAlbumRoute(req, res, url) {
  try {
    requireAlbumAuth(req);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/albums/manage") {
      await handleAlbumManageList(res);
      return;
    }
    if (req.method === "POST" && pathname === "/albums") {
      await handleAlbumCreate(req, res);
      return;
    }
    if (
      pathname === "/albums/film-stock-presets" &&
      ["GET", "POST"].includes(req.method)
    ) {
      await handleFilmStockPresets(req, res);
      return;
    }

    let match = pathname.match(/^\/albums\/([^/]+)$/);
    if (req.method === "PATCH" && match) {
      await handleAlbumPatch(
        req,
        res,
        normalizeAlbumId(decodeURIComponent(match[1]))
      );
      return;
    }

    match = pathname.match(/^\/albums\/([^/]+)\/film-scans$/);
    if (req.method === "POST" && match) {
      await handleFilmScanCreate(
        req,
        res,
        normalizeAlbumId(decodeURIComponent(match[1]))
      );
      return;
    }

    match = pathname.match(
      /^\/albums\/([^/]+)\/film-scans\/([^/]+)\/frames\/([^/]+)\/preview$/
    );
    if (req.method === "GET" && match) {
      await handleFilmScanPreviewAsset(
        res,
        normalizeAlbumId(decodeURIComponent(match[1])),
        normalizeAlbumId(decodeURIComponent(match[2]), "job id"),
        normalizeAlbumId(decodeURIComponent(match[3]), "frame id")
      );
      return;
    }

    match = pathname.match(
      /^\/albums\/([^/]+)\/film-scans\/([^/]+)\/sources\/([^/]+)\/preview$/
    );
    if (req.method === "GET" && match) {
      await handleFilmScanSourcePreviewAsset(
        res,
        normalizeAlbumId(decodeURIComponent(match[1])),
        normalizeAlbumId(decodeURIComponent(match[2]), "job id"),
        normalizeAlbumId(decodeURIComponent(match[3]), "source id")
      );
      return;
    }

    match = pathname.match(
      /^\/albums\/([^/]+)\/film-scans\/([^/]+)\/frames\/([^/]+)$/
    );
    if (req.method === "PATCH" && match) {
      await handleFilmScanFramePatch(
        req,
        res,
        normalizeAlbumId(decodeURIComponent(match[1])),
        normalizeAlbumId(decodeURIComponent(match[2]), "job id"),
        normalizeAlbumId(decodeURIComponent(match[3]), "frame id")
      );
      return;
    }

    match = pathname.match(
      /^\/albums\/([^/]+)\/film-scans\/([^/]+)\/(preview|commit|retry|cancel)$/
    );
    if (req.method === "POST" && match) {
      const albumId = normalizeAlbumId(decodeURIComponent(match[1]));
      const jobId = normalizeAlbumId(decodeURIComponent(match[2]), "job id");
      if (match[3] === "preview") {
        await handleFilmScanPreview(req, res, albumId, jobId);
      } else if (match[3] === "commit") {
        await handleFilmScanCommit(req, res, albumId, jobId);
      } else if (match[3] === "retry") {
        await handleFilmScanRetry(res, albumId, jobId);
      } else {
        await handleFilmScanCancel(res, albumId, jobId);
      }
      return;
    }

    match = pathname.match(
      /^\/albums\/([^/]+)\/film-scans\/(?:jobs\/)?([^/]+)$/
    );
    if (match && ["GET", "PATCH"].includes(req.method)) {
      const albumId = normalizeAlbumId(decodeURIComponent(match[1]));
      const jobId = normalizeAlbumId(decodeURIComponent(match[2]), "job id");
      if (req.method === "GET") {
        await handleFilmScanGet(res, albumId, jobId);
      } else {
        await handleFilmScanJobPatch(req, res, albumId, jobId);
      }
      return;
    }

    match = pathname.match(/^\/albums\/([^/]+)\/photos$/);
    if (req.method === "POST" && match) {
      await handleAlbumPhotoUpload(
        req,
        res,
        normalizeAlbumId(decodeURIComponent(match[1]))
      );
      return;
    }

    match = pathname.match(/^\/albums\/([^/]+)\/photos\/reorder$/);
    if (req.method === "POST" && match) {
      await handleAlbumPhotoReorder(
        req,
        res,
        normalizeAlbumId(decodeURIComponent(match[1]))
      );
      return;
    }

    match = pathname.match(
      /^\/albums\/([^/]+)\/photos\/([^/]+)\/hdr$/
    );
    if (req.method === "POST" && match) {
      await handleAlbumPhotoHdrUpload(
        req,
        res,
        normalizeAlbumId(decodeURIComponent(match[1])),
        normalizeAlbumId(decodeURIComponent(match[2]), "photo id")
      );
      return;
    }

    match = pathname.match(/^\/albums\/([^/]+)\/photos\/([^/]+)$/);
    if (match && ["PATCH", "DELETE"].includes(req.method)) {
      const albumId = normalizeAlbumId(decodeURIComponent(match[1]));
      const photoId = normalizeAlbumId(
        decodeURIComponent(match[2]),
        "photo id"
      );
      if (req.method === "PATCH") {
        await handleAlbumPhotoPatch(req, res, albumId, photoId);
      } else {
        await handleAlbumPhotoDelete(res, albumId, photoId);
      }
      return;
    }

    match = pathname.match(/^\/albums\/([^/]+)\/cover$/);
    if (req.method === "PUT" && match) {
      await handleAlbumCover(
        req,
        res,
        normalizeAlbumId(decodeURIComponent(match[1]))
      );
      return;
    }

    throw httpError(404, "Album management endpoint not found.");
  } catch (error) {
    const clientError =
      [401, 403].includes(error.directusHttpStatus || 0)
        ? httpError(502, "Directus service authorization failed.")
        : error;
    if (!res.headersSent) {
      sendJson(res, clientError.statusCode || 500, {
        status: "error",
        error: clientError.message
      });
    }
  }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw httpError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function hashAnalyticsValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "";
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeAnalyticsEvent(body, req) {
  const eventType = truncateText(body.eventType || body.event_type, 24);
  const itemType = truncateText(body.itemType || body.item_type, 24);
  const itemId = parseInteger(body.itemId || body.item_id);
  const masterId = parseInteger(body.masterId || body.master_id);

  if (!ANALYTICS_EVENT_TYPES.has(eventType)) {
    throw httpError(400, "eventType must be view or play.");
  }

  if (!ANALYTICS_ITEM_TYPES.has(itemType)) {
    throw httpError(400, "itemType must be post or video.");
  }

  if (!itemId) {
    throw httpError(400, "itemId is required.");
  }

  if (eventType === "play" && itemType !== "video") {
    throw httpError(400, "play events are only supported for videos.");
  }

  const userAgent = truncateText(req.headers["user-agent"] || "", 500);
  const rawVisitor =
    truncateText(body.visitorId || body.visitor_id, 120) ||
    `${clientAddress(req)}|${userAgent}`;

  return {
    eventType,
    itemType,
    itemId,
    masterId,
    visitorHash: hashAnalyticsValue(rawVisitor),
    path: truncateText(body.path, 500),
    referrer: truncateText(body.referrer, 500),
    userAgent
  };
}

async function getAnalyticsItemRecord(token, event) {
  const collection = event.itemType === "post" ? "posts" : "video_projects";
  const data = await directusRequest(
    `/items/${collection}/${event.itemId}?fields=id,title,slug`,
    token
  );

  return data.data;
}

async function syncAnalyticsItem(token, event) {
  const item = await getAnalyticsItemRecord(token, event);
  const itemKey = `${event.itemType}:${event.itemId}`;
  const eventParams = new URLSearchParams({
    "filter[item_key][_eq]": itemKey,
    fields: "event_type,visitor_hash,created_at",
    limit: "-1"
  });
  const events = (
    await directusRequest(`/items/analytics_events?${eventParams.toString()}`, token)
  ).data || [];
  const viewEvents = events.filter((itemEvent) => itemEvent.event_type === "view");
  const playEvents = events.filter((itemEvent) => itemEvent.event_type === "play");
  const lastEventAt = events
    .map((itemEvent) => itemEvent.created_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  const payload = {
    item_type: event.itemType,
    item_key: itemKey,
    title: item.title,
    slug: item.slug,
    post_id: event.itemType === "post" ? item.id : null,
    video_project_id: event.itemType === "video" ? item.id : null,
    view_count: viewEvents.length,
    visitor_count: new Set(viewEvents.map((itemEvent) => itemEvent.visitor_hash)).size,
    play_count: playEvents.length,
    player_count: new Set(playEvents.map((itemEvent) => itemEvent.visitor_hash)).size,
    last_event_at: lastEventAt,
    updated_at: new Date().toISOString()
  };

  const itemParams = new URLSearchParams({
    "filter[item_key][_eq]": itemKey,
    fields: "id",
    limit: "1"
  });
  const existing = (
    await directusRequest(`/items/analytics_items?${itemParams.toString()}`, token)
  ).data?.[0];

  if (existing) {
    return (
      await directusRequest(`/items/analytics_items/${existing.id}`, token, {
        method: "PATCH",
        body: payload
      })
    ).data;
  }

  return (
    await directusRequest("/items/analytics_items", token, {
      method: "POST",
      body: payload
    })
  ).data;
}

async function handleAnalyticsEvent(req, res) {
  try {
    const event = normalizeAnalyticsEvent(await readJsonBody(req), req);
    const token = await directusLogin();
    const item = await getAnalyticsItemRecord(token, event);
    const now = new Date().toISOString();
    const itemKey = `${event.itemType}:${event.itemId}`;

    const created = await directusRequest("/items/analytics_events", token, {
      method: "POST",
      body: {
        event_type: event.eventType,
        item_type: event.itemType,
        item_key: itemKey,
        post_id: event.itemType === "post" ? item.id : null,
        video_project_id: event.itemType === "video" ? item.id : null,
        video_master_id: event.masterId || null,
        visitor_hash: event.visitorHash,
        path: event.path,
        referrer: event.referrer,
        user_agent: event.userAgent,
        created_at: now
      }
    });

    const aggregate = await syncAnalyticsItem(token, event);

    sendJson(res, 201, {
      status: "ok",
      event: created.data.id,
      aggregate
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      status: "error",
      error: error.message
    });
  }
}

async function findProjectBySlug(token, slug) {
  const params = new URLSearchParams({
    "filter[slug][_eq]": slug,
    limit: "1"
  });
  const data = await directusRequest(`/items/video_projects?${params.toString()}`, token);
  return data.data[0] || null;
}

async function createOrUpdateDirectusRecords(
  metadata,
  sourcePath,
  playlistPath,
  probe,
  files,
  sidecar = {},
  verificationResult = {}
) {
  const token = await directusLogin();
  const existingProject = await findProjectBySlug(token, metadata.slug);
  const coverImageId = await directusUploadFile(token, files.cover, `${metadata.title} cover`);
  const dovi = extractDolbyVisionMetadata(probe);
  const dolbyCompatibilityId = sidecar.compatibilityId || stringOrNull(dovi.compatibilityId);
  const dolbyProfileVersion = normalizeDolbyProfileVersion(
    sidecar.profile || stringOrNull(dovi.profile),
    dolbyCompatibilityId
  );
  const projectPayload = {
    title: metadata.title,
    slug: metadata.slug,
    description: metadata.description,
    category: metadata.category,
    tags: metadata.tags,
    published: metadata.published,
    sort_order: 0
  };

  if (coverImageId) {
    projectPayload.cover_image = coverImageId;
  }

  const project = existingProject
    ? (
        await directusRequest(`/items/video_projects/${existingProject.id}`, token, {
          method: "PATCH",
          body: projectPayload
        })
      ).data
    : (
        await directusRequest("/items/video_projects", token, {
          method: "POST",
          body: projectPayload
        })
      ).data;

  if (metadata.isDefault) {
    await clearDefaultMasters(token, project.id);
  }

  const sourceContract = verificationResult.sourceContract || buildColorContract(probe, metadata, sidecar);
  const outputContract = verificationResult.outputContract || sourceContract;
  const verification = verificationResult.verification || {
    status: "ready",
    errors: [],
    verifiedAt: new Date().toISOString()
  };
  const sourceHash = fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()
    ? await sha256File(sourcePath)
    : null;

  const masterPayload = {
    project_id: project.id,
    label: metadata.label,
    type: metadata.masterType,
    hls_url: mediaUrlFromPath(playlistPath),
    file_url: mediaUrlFromPath(sourcePath),
    codec: prettyCodec(outputContract.codecName || probe.codec_name, metadata.masterType),
    resolution_width: metadata.resolutionWidth || outputContract.width || probe.width,
    resolution_height: metadata.resolutionHeight || outputContract.height || probe.height,
    color_space: outputContract.displayGamutLabel || prettyColorSpace(probe, metadata.masterType),
    transfer_function: outputContract.transferFunctionLabel || prettyTransferFunction(probe, metadata.masterType),
    bit_depth: outputContract.bitDepth || inferBitDepth(probe, metadata.masterType),
    bitrate_mbps: metadata.bitrateMbps,
    dolby_profile: dolbyProfileVersion,
    dolby_level: sidecar.level || stringOrNull(dovi.level),
    dolby_compatibility_id: dolbyCompatibilityId,
    dolby_rpu_present: booleanOrFalse(dovi.rpuPresent),
    dolby_el_present: booleanOrFalse(dovi.elPresent),
    dolby_bl_present: booleanOrFalse(dovi.blPresent),
    is_default: metadata.isDefault,
    sort_order: 0,
    status: "ready",
    processing_mode: metadata.processingMode,
    is_derivative: metadata.isDerivative,
    derived_from_master_id: metadata.derivedFromMasterId,
    source_sha256: sourceHash,
    display_gamut: outputContract.displayGamut,
    color_primaries: outputContract.colorPrimaries,
    color_transfer: outputContract.colorTransfer,
    matrix_coefficients: outputContract.matrixCoefficients,
    color_range: outputContract.colorRange,
    pixel_format: outputContract.pixelFormat,
    chroma_location: outputContract.chromaLocation,
    hls_video_range: outputContract.hlsVideoRange,
    hdr_static_metadata: outputContract.hdrStaticMetadata,
    dolby_metadata: outputContract.dolbyMetadata,
    source_probe_json: verificationResult.sourceProbe || probe,
    output_probe_json: verificationResult.outputProbe || probe,
    verification_status: verification.status,
    verification_errors: verification.errors,
    verified_at: verification.verifiedAt,
    conversion_intent: metadata.conversionIntent,
    conversion_lut_or_filter: metadata.conversionLutOrFilter,
    uploaded_at: new Date().toISOString(),
    notes: metadata.notes
  };

  const existingMasters = metadata.overwrite
    ? await findMastersByIdentity(token, project.id, metadata)
    : [];
  const master = existingMasters[0]
    ? (
        await directusRequest(`/items/video_masters/${existingMasters[0].id}`, token, {
          method: "PATCH",
          body: masterPayload
        })
      ).data
    : (
        await directusRequest("/items/video_masters", token, {
          method: "POST",
          body: masterPayload
        })
      ).data;

  for (const staleMaster of existingMasters.slice(1)) {
    await directusRequest(`/items/video_masters/${staleMaster.id}`, token, {
      method: "DELETE"
    });
  }

  return { project, master };
}

async function findMastersByIdentity(token, projectId, metadata) {
  const params = new URLSearchParams({
    "filter[project_id][_eq]": String(projectId),
    "filter[type][_eq]": metadata.masterType,
    "filter[label][_eq]": metadata.label,
    sort: "id",
    limit: "-1"
  });
  const data = await directusRequest(`/items/video_masters?${params.toString()}`, token);
  return data.data || [];
}

async function clearDefaultMasters(token, projectId) {
  const params = new URLSearchParams({
    "filter[project_id][_eq]": String(projectId),
    "filter[is_default][_eq]": "true",
    limit: "-1"
  });
  const data = await directusRequest(`/items/video_masters?${params.toString()}`, token);

  for (const master of data.data) {
    await directusRequest(`/items/video_masters/${master.id}`, token, {
      method: "PATCH",
      body: {
        is_default: false
      }
    });
  }
}

async function handleUpload(req, res) {
  let parsed = null;

  try {
    requireUploadAuth(req);
    parsed = await parseMultipart(req);
    const metadata = normalizeUpload(parsed.fields);
    validateProcessingPolicy(metadata);
    const packageInfo =
      metadata.sourceKind === "master_package" || metadata.sourceKind === "hls_package"
        ? await moveMasterPackageFiles(parsed.files.masterPackage, metadata)
        : null;
    const sourcePath = packageInfo
      ? packageInfo.sourcePath
      : await moveSourceFile(parsed.file, metadata);
    const dolbySidecar = await parseDolbyProfileFiles(
      packageInfo?.sidecars || [],
      parsed.fields.dolbyXmlClipName || parsed.fields.dolby_xml_clip_name || ""
    );
    const hlsInspection =
      metadata.sourceKind === "hls_package"
        ? await inspectHlsPackage(packageInfo, metadata, dolbySidecar)
        : null;
    const probe = hlsInspection?.probe || await probeVideo(sourcePath);
    validateDolbyVisionUpload(metadata, probe, dolbySidecar);
    const sourceContract =
      hlsInspection?.contract ||
      buildColorContract(probe, metadata, dolbySidecar, {
        hlsVideoRange: expectedVideoRange(metadata)
      });
    const sourceErrors = validateColorContract(metadata, sourceContract, "source");
    if (sourceErrors.length) {
      throwColorContractError(sourceErrors);
    }

    const outputDir = await prepareOutputDir(metadata);
    const hlsOutput =
      metadata.sourceKind === "hls_package"
        ? await prepareHlsPackageOutput(packageInfo, outputDir)
        : await generateHls(sourcePath, outputDir, metadata, probe);
    const finalized = await finalizeHlsOutput(
      hlsOutput,
      metadata,
      sourceContract,
      dolbySidecar,
      probe
    );
    const records = await createOrUpdateDirectusRecords(
      metadata,
      sourcePath,
      finalized.playlistPath,
      probe,
      parsed.files,
      dolbySidecar,
      {
        sourceContract,
        outputContract: finalized.outputContract,
        sourceProbe: probe,
        outputProbe: finalized.outputProbe,
        verification: finalized.verification
      }
    );

    sendJson(res, 201, {
      status: "ok",
      project: records.project,
      master: records.master,
      sourceKind: metadata.sourceKind,
      masterPackage: packageInfo
        ? {
            fileCount: packageInfo.files.length,
            sourceFile: path.relative(packageInfo.packageDir, packageInfo.sourcePath).replace(/\\/g, "/"),
            sidecarCount: packageInfo.sidecars.length
          }
        : null,
      sourceUrl: mediaUrlFromPath(sourcePath),
      hlsUrl: mediaUrlFromPath(finalized.playlistPath),
      probe,
      colorContract: finalized.outputContract,
      verification: finalized.verification,
      derivativeOf: metadata.isDerivative ? metadata.derivedFromMasterId : null
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      status: "error",
      error: error.message,
      verificationErrors: error.verificationErrors || null
    });
  } finally {
    if (parsed?.tempDir) {
      await fsp.rm(parsed.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function handleHealth(res) {
  const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
    commandAvailable(FFMPEG_PATH),
    commandAvailable(FFPROBE_PATH)
  ]);

  sendJson(res, 200, {
    status: "ok",
    mediaRoot: MEDIA_ROOT,
    directusUrl: DIRECTUS_URL,
    uploadAuthRequired: Boolean(UPLOAD_API_TOKEN),
    articlePublishingEnabled: Boolean(ARTICLE_API_TOKEN),
    articleLimits: {
      requestBytes: MAX_ARTICLE_UPLOAD_BYTES,
      imageBytes: MAX_ARTICLE_IMAGE_BYTES,
      markdownBytes: MAX_ARTICLE_MARKDOWN_BYTES,
      inlineImages: MAX_ARTICLE_IMAGES
    },
    albumPublishingEnabled: Boolean(UPLOAD_API_TOKEN),
    albumLimits: {
      requestBytes: MAX_ALBUM_UPLOAD_BYTES,
      imageBytes: MAX_ALBUM_IMAGE_BYTES,
      photosPerBatch: MAX_ALBUM_PHOTOS,
      assetPresets: [...ALBUM_ASSET_PRESETS]
    },
    filmScan: {
      enabled: true,
      sourceBytes: MAX_FILM_SCAN_SOURCE_BYTES,
      jobBytes: MAX_FILM_SCAN_JOB_BYTES,
      sourcesPerJob: MAX_FILM_SCAN_SOURCES,
      maxPixels: 800_000_000,
      queueConcurrency: 1,
      formats: ["fff", "3f", "tiff", "jpeg"],
      experimentalScanners: [
        "hasselblad-x5",
        "fujifilm-sp3000",
        "noritsu-hs1800"
      ]
    },
    ffmpeg: {
      path: FFMPEG_PATH,
      available: ffmpegAvailable
    },
    ffprobe: {
      path: FFPROBE_PATH,
      available: ffprobeAvailable
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/health") {
    await handleHealth(res);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/media/")) {
    await handleMedia(url.pathname, res);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    await handleAsset(url, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/uploads/videos") {
    await handleUpload(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/articles") {
    await handleArticleCreate(req, res);
    return;
  }

  if (url.pathname === "/albums" || url.pathname.startsWith("/albums/")) {
    await handleAlbumRoute(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/analytics/events") {
    await handleAnalyticsEvent(req, res);
    return;
  }

  sendJson(res, 404, {
    status: "error",
    error: "Not found"
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Upload API listening on http://${HOST}:${PORT}`);
  void recoverFilmScanQueue();
});

async function handleMedia(pathname, res) {
  try {
    const relativePath = decodeURIComponent(pathname.replace(/^\/media\//, ""));
    const filePath = path.resolve(MEDIA_ROOT, relativePath);
    assertInside(MEDIA_ROOT, filePath);

    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      throw httpError(404, "Media file not found.");
    }

    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": stat.size,
      "Cache-Control": cacheControl(filePath)
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendJson(res, error.statusCode || 404, {
      status: "error",
      error: error.message
    });
  }
}

async function fetchDirectusAsset(assetUrl, token, authRetried = false) {
  const response = await fetch(assetUrl, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (
    !authRetried &&
    [401, 403].includes(response.status)
  ) {
    await response.arrayBuffer().catch(() => {});
    const refreshedToken = await refreshDirectusLogin(token);
    return fetchDirectusAsset(assetUrl, refreshedToken, true);
  }
  return response;
}

async function handleAsset(url, res) {
  try {
    const pathname = url.pathname;
    const fileId = decodeURIComponent(pathname.replace(/^\/assets\//, "")).split("/")[0];
    if (!/^[a-zA-Z0-9-]+$/.test(fileId)) {
      throw httpError(400, "Invalid asset id.");
    }

    const requestedKeys = url.searchParams.getAll("key");
    if (requestedKeys.length > 1) {
      throw httpError(400, "Only one asset preset may be requested.");
    }
    const preset = requestedKeys[0] || null;
    if (preset && !ALBUM_ASSET_PRESETS.has(preset)) {
      throw httpError(400, "Unsupported asset preset.");
    }
    for (const parameter of url.searchParams.keys()) {
      if (parameter !== "key") {
        throw httpError(400, "Arbitrary asset transformations are not allowed.");
      }
    }

    const token = await directusLogin();
    const assetUrl = new URL(
      `${DIRECTUS_URL}/assets/${encodeURIComponent(fileId)}`
    );
    if (preset) {
      assetUrl.searchParams.set("key", preset);
    }
    const response = await fetchDirectusAsset(assetUrl, token);

    if (!response.ok) {
      throw httpError(response.status, `Directus asset request failed: ${response.statusText}`);
    }

    res.writeHead(200, {
      "Content-Type": response.headers.get("content-type") || "application/octet-stream",
      ...(response.headers.get("content-length")
        ? { "Content-Length": response.headers.get("content-length") }
        : {}),
      "Cache-Control": "public, max-age=86400"
    });

    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    sendJson(res, error.statusCode || 404, {
      status: "error",
      error: error.message
    });
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  return (
    {
      ".m3u8": "application/vnd.apple.mpegurl",
      ".ts": "video/mp2t",
      ".m4s": "video/iso.segment",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".sog": "application/octet-stream",
      ".ply": "application/octet-stream",
      ".json": "application/json; charset=utf-8",
      ".webp": "image/webp",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg"
    }[ext] || "application/octet-stream"
  );
}

function cacheControl(filePath) {
  return path.extname(filePath).toLowerCase() === ".m3u8"
    ? "no-cache, no-store, must-revalidate"
    : "public, max-age=86400";
}
