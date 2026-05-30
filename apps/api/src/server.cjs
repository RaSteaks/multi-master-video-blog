const Busboy = require("busboy");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "..", "..");
const env = loadEnv(path.join(ROOT, ".env"));

const HOST = env.HOST || "127.0.0.1";
const PORT = Number(env.PORT || 8060);
const DIRECTUS_URL = stripTrailingSlash(env.DIRECTUS_URL || "http://127.0.0.1:8055");
const DIRECTUS_EMAIL = env.DIRECTUS_EMAIL || "admin@example.com";
const DIRECTUS_PASSWORD = env.DIRECTUS_PASSWORD || "change-this-local-password";
const UPLOAD_API_TOKEN = env.UPLOAD_API_TOKEN || "";
const MEDIA_ROOT = path.resolve(ROOT, env.MEDIA_ROOT || "../../media");
const MAX_UPLOAD_BYTES = Number(env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024);
const FFMPEG_PATH = env.FFMPEG_PATH || resolveOptionalPackage("ffmpeg-static") || "ffmpeg";
const FFPROBE_PATH =
  env.FFPROBE_PATH || resolveOptionalPackage("ffprobe-static", "path") || "ffprobe";

const MASTER_TYPES = new Set(["sdr", "hdr10", "hlg", "dolby_vision", "custom"]);
const TRANSCODE_TYPES = new Set(["sdr", "hdr10", "hlg", "custom"]);

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
    return;
  }

  const authorization = req.headers.authorization || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const uploadToken = req.headers["x-upload-token"] || "";

  if (bearer === UPLOAD_API_TOKEN || uploadToken === UPLOAD_API_TOKEN) {
    return;
  }

  throw httpError(401, "Missing or invalid upload API token.");
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
        files: 3,
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
      if (!["video", "cover", "poster"].includes(name)) {
        file.resume();
        return;
      }

      const filename = safeFileName(info.filename);
      const tempPath = path.join(tempDir, filename);
      const writeStream = fs.createWriteStream(tempPath);

      const currentFile = {
        field: name,
        filename,
        mimeType: info.mimeType,
        tempPath,
        tempDir
      };
      files[name] = currentFile;

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

        if (!fileInfo) {
          throw httpError(400, "Missing video file field named `video`.");
        }

        resolve({
          fields,
          files,
          tempDir,
          file: {
            ...fileInfo,
            size: uploadBytes
          }
        });
      } catch (error) {
        rejectOnce(error);
      }
    });

    req.pipe(busboy);
  });
}

function normalizeUpload(fields) {
  const title = String(fields.title || "").trim();
  const slug = String(fields.slug || "").trim();
  const masterType = String(fields.masterType || fields.type || "sdr").trim();

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

  const mode =
    fields.mode === "copy" || masterType === "dolby_vision"
      ? "copy"
      : "transcode";

  return {
    title,
    slug,
    description: fields.description || "",
    category: fields.category || null,
    tags: parseTags(fields.tags),
    published: parseBoolean(fields.published, false),
    masterType,
    label: fields.label || defaultLabel(masterType),
    isDefault: parseBoolean(fields.isDefault, masterType === "sdr"),
    overwrite: parseBoolean(fields.overwrite, false),
    mode,
    codec: fields.codec || defaultCodec(masterType, mode),
    colorSpace: fields.colorSpace || fields.color_space || defaultColorSpace(masterType),
    transferFunction:
      fields.transferFunction || fields.transfer_function || defaultTransferFunction(masterType),
    bitDepth: parseInteger(fields.bitDepth || fields.bit_depth) || defaultBitDepth(masterType),
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
  const sourceDir = path.join(MEDIA_ROOT, metadata.slug, "source");
  const sourcePath = path.join(sourceDir, `${Date.now()}-${file.filename}`);

  assertInside(MEDIA_ROOT, sourceDir);
  assertInside(MEDIA_ROOT, sourcePath);

  await fsp.mkdir(sourceDir, { recursive: true });
  await fsp.rename(file.tempPath, sourcePath);

  return sourcePath;
}

async function prepareOutputDir(metadata) {
  const outputDir = path.join(MEDIA_ROOT, metadata.slug, metadata.masterType.replace("_", "-"));
  assertInside(MEDIA_ROOT, outputDir);

  if (fs.existsSync(outputDir)) {
    const entries = await fsp.readdir(outputDir);
    if (entries.length > 0 && !metadata.overwrite) {
      throw httpError(409, `HLS output directory already exists and is not empty: ${outputDir}`);
    }

    if (metadata.overwrite) {
      await fsp.rm(outputDir, { recursive: true, force: true });
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
    "-show_entries",
    "stream=codec_name,width,height,pix_fmt,color_space,color_transfer,color_primaries,bits_per_raw_sample",
    "-of",
    "json",
    sourcePath
  ]);

  const parsed = JSON.parse(stdout);
  return parsed.streams?.[0] || {};
}

async function generateHls(sourcePath, outputDir, metadata) {
  const playlistPath = path.join(outputDir, "master.m3u8");

  if (metadata.mode === "copy") {
    await runProcess(FFMPEG_PATH, [
      "-y",
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "copy",
      "-tag:v",
      "hvc1",
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
      playlistPath
    ]);
    return playlistPath;
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
  ];

  if (TRANSCODE_TYPES.has(metadata.masterType)) {
    await runProcess(FFMPEG_PATH, args);
    return playlistPath;
  }

  throw httpError(400, `Unsupported transcode masterType: ${metadata.masterType}`);
}

function mediaUrlFromPath(filePath) {
  assertInside(MEDIA_ROOT, filePath);
  const relative = path.relative(MEDIA_ROOT, filePath).replace(/\\/g, "/");
  return `/media/${relative}`;
}

async function directusRequest(pathname, token, options = {}) {
  const response = await fetch(`${DIRECTUS_URL}${pathname}`, {
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

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.errors?.[0]?.message || text || response.statusText;
    throw httpError(response.status, `Directus ${options.method || "GET"} ${pathname} failed: ${message}`);
  }

  return data;
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

  const response = await fetch(`${DIRECTUS_URL}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.errors?.[0]?.message || text || response.statusText;
    throw httpError(response.status, `Directus file upload failed: ${message}`);
  }

  return data.data.id;
}

async function directusLogin() {
  const data = await directusRequest("/auth/login", null, {
    method: "POST",
    body: {
      email: DIRECTUS_EMAIL,
      password: DIRECTUS_PASSWORD
    }
  });

  return data.data.access_token;
}

async function findProjectBySlug(token, slug) {
  const params = new URLSearchParams({
    "filter[slug][_eq]": slug,
    limit: "1"
  });
  const data = await directusRequest(`/items/video_projects?${params.toString()}`, token);
  return data.data[0] || null;
}

async function createOrUpdateDirectusRecords(metadata, sourcePath, playlistPath, probe, files) {
  const token = await directusLogin();
  const existingProject = await findProjectBySlug(token, metadata.slug);
  const coverImageId = await directusUploadFile(token, files.cover, `${metadata.title} cover`);
  const posterImageId = await directusUploadFile(token, files.poster, `${metadata.title} poster`);
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

  if (posterImageId) {
    projectPayload.poster_image = posterImageId;
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

  const masterPayload = {
    project_id: project.id,
    label: metadata.label,
    type: metadata.masterType,
    hls_url: mediaUrlFromPath(playlistPath),
    file_url: mediaUrlFromPath(sourcePath),
    codec: metadata.codec || probe.codec_name,
    resolution_width: metadata.resolutionWidth || probe.width,
    resolution_height: metadata.resolutionHeight || probe.height,
    color_space: metadata.colorSpace,
    transfer_function: metadata.transferFunction,
    bit_depth: metadata.bitDepth,
    bitrate_mbps: metadata.bitrateMbps,
    is_default: metadata.isDefault,
    sort_order: 0,
    status: "ready",
    uploaded_at: new Date().toISOString(),
    notes: metadata.notes
  };

  const master = (
    await directusRequest("/items/video_masters", token, {
      method: "POST",
      body: masterPayload
    })
  ).data;

  return { project, master };
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
    const sourcePath = await moveSourceFile(parsed.file, metadata);
    const outputDir = await prepareOutputDir(metadata);
    const probe = await probeVideo(sourcePath);
    const playlistPath = await generateHls(sourcePath, outputDir, metadata);
    const records = await createOrUpdateDirectusRecords(
      metadata,
      sourcePath,
      playlistPath,
      probe,
      parsed.files
    );

    sendJson(res, 201, {
      status: "ok",
      project: records.project,
      master: records.master,
      sourceUrl: mediaUrlFromPath(sourcePath),
      hlsUrl: mediaUrlFromPath(playlistPath),
      probe
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      status: "error",
      error: error.message
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

  if (req.method === "POST" && url.pathname === "/uploads/videos") {
    await handleUpload(req, res);
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
      "Cache-Control": "public, max-age=86400"
    });
    fs.createReadStream(filePath).pipe(res);
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
      ".mov": "video/quicktime"
    }[ext] || "application/octet-stream"
  );
}
