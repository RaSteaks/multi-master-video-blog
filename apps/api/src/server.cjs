const Busboy = require("busboy");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");

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
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
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
  const method = String(options.method || "GET").toUpperCase();
  let response;
  try {
    response = await fetch(`${DIRECTUS_URL}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      },
      body:
        options.body && typeof options.body !== "string"
          ? JSON.stringify(options.body)
          : options.body
    });
  } catch (cause) {
    throw directusTransportError(method, pathname, cause);
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

async function directusUploadFile(token, file, title) {
  if (!file) {
    return null;
  }

  const buffer = await fsp.readFile(file.tempPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer], { type: file.mimeType || "application/octet-stream" }),
    file.filename
  );

  if (title) {
    form.append("title", title);
  }

  let response;
  try {
    response = await fetch(`${DIRECTUS_URL}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
  } catch (cause) {
    throw directusTransportError("POST", "/files", cause);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (cause) {
    const error = httpError(502, "Directus file upload returned invalid JSON.");
    error.directusRequestSent = true;
    error.directusResponseStatus = response.status;
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
    throw httpError(502, "Directus file upload response did not include a file id.");
  }

  return data.data.id;
}

async function directusLogin() {
  try {
    const data = await directusRequest("/auth/login", null, {
      method: "POST",
      body: {
        email: DIRECTUS_EMAIL,
        password: DIRECTUS_PASSWORD
      }
    });

    if (!data?.data?.access_token) {
      throw httpError(502, "Directus login response did not include an access token.");
    }
    return data.data.access_token;
  } catch (error) {
    if ([401, 403].includes(error.directusHttpStatus || error.statusCode)) {
      const upstreamError = httpError(502, "Directus service authentication failed.");
      upstreamError.cause = error;
      throw upstreamError;
    }
    throw error;
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
    await handleAsset(url.pathname, res);
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

async function handleAsset(pathname, res) {
  try {
    const fileId = decodeURIComponent(pathname.replace(/^\/assets\//, "")).split("/")[0];
    if (!/^[a-zA-Z0-9-]+$/.test(fileId)) {
      throw httpError(400, "Invalid asset id.");
    }

    const token = await directusLogin();
    const response = await fetch(`${DIRECTUS_URL}/assets/${encodeURIComponent(fileId)}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

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
