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

  if (!["embedded", "master_package"].includes(sourceKind)) {
    throw httpError(400, "sourceKind must be embedded or master_package.");
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
    sourceKind,
    masterType,
    label: fields.label || defaultLabel(masterType),
    isDefault: parseBoolean(fields.isDefault, masterType === "sdr"),
    overwrite: parseBoolean(fields.overwrite, false),
    mode,
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

  const primary = selectMasterPackagePrimary(movedFiles);
  if (!primary) {
    throw httpError(
      400,
      "No primary video essence was found in the master package. Include MP4, MOV, MXF, MKV, HEVC, H265, or 265 files."
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
  const versionSegment = metadata.overwrite
    ? labelSegment
    : `${Date.now()}-${labelSegment}`;
  const outputDir = path.join(MEDIA_ROOT, metadata.slug, typeSegment, versionSegment);
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
    "-show_streams",
    "-of",
    "json",
    sourcePath
  ]);

  const parsed = JSON.parse(stdout);
  return parsed.streams?.[0] || {};
}

async function generateHls(sourcePath, outputDir, metadata, probe = {}) {
  const playlistPath = path.join(outputDir, "master.m3u8");

  if (shouldCreatePreviewHls(metadata, probe)) {
    await generatePreviewHls(sourcePath, outputDir, playlistPath);
    return playlistPath;
  }

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
      playlistPath
    );

    await runProcess(FFMPEG_PATH, args, { cwd: outputDir });
    await stampHlsPlaylist(playlistPath);
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
  ];

  if (TRANSCODE_TYPES.has(metadata.masterType)) {
    await runProcess(FFMPEG_PATH, args);
    await stampHlsPlaylist(playlistPath);
    return playlistPath;
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

function mediaUrlFromPath(filePath) {
  assertInside(MEDIA_ROOT, filePath);
  const relative = path.relative(MEDIA_ROOT, filePath).replace(/\\/g, "/");
  return `/media/${relative}`;
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
  const color = String(probe.color_space || probe.color_primaries || "").toLowerCase();
  if (color.includes("bt2020") || color.includes("2020")) {
    return "BT.2020";
  }

  if (color.includes("bt709") || color.includes("709")) {
    return "BT.709";
  }

  return defaultColorSpace(masterType);
}

function prettyTransferFunction(probe, masterType) {
  const transfer = String(probe.color_transfer || "").toLowerCase();
  if (transfer.includes("smpte2084") || transfer.includes("pq")) {
    return "PQ / ST2084";
  }

  if (transfer.includes("arib-std-b67") || transfer.includes("hlg")) {
    return "HLG";
  }

  if (transfer.includes("bt709") || transfer.includes("709")) {
    return "BT.709";
  }

  return defaultTransferFunction(masterType);
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

async function createOrUpdateDirectusRecords(metadata, sourcePath, playlistPath, probe, files, sidecar = {}) {
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

  const masterPayload = {
    project_id: project.id,
    label: metadata.label,
    type: metadata.masterType,
    hls_url: mediaUrlFromPath(playlistPath),
    file_url: mediaUrlFromPath(sourcePath),
    codec: metadata.codec || prettyCodec(probe.codec_name, metadata.masterType),
    resolution_width: metadata.resolutionWidth || probe.width,
    resolution_height: metadata.resolutionHeight || probe.height,
    color_space: metadata.colorSpace || prettyColorSpace(probe, metadata.masterType),
    transfer_function: metadata.transferFunction || prettyTransferFunction(probe, metadata.masterType),
    bit_depth: metadata.bitDepth || inferBitDepth(probe, metadata.masterType),
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
    const packageInfo =
      metadata.sourceKind === "master_package"
        ? await moveMasterPackageFiles(parsed.files.masterPackage, metadata)
        : null;
    const sourcePath = packageInfo
      ? packageInfo.sourcePath
      : await moveSourceFile(parsed.file, metadata);
    const outputDir = await prepareOutputDir(metadata);
    const probe = await probeVideo(sourcePath);
    const dolbySidecar = await parseDolbyProfileFiles(
      packageInfo?.sidecars || [],
      parsed.fields.dolbyXmlClipName || parsed.fields.dolby_xml_clip_name || ""
    );
    validateDolbyVisionUpload(metadata, probe, dolbySidecar);
    const playlistPath = await generateHls(sourcePath, outputDir, metadata, probe);
    const records = await createOrUpdateDirectusRecords(
      metadata,
      sourcePath,
      playlistPath,
      probe,
      parsed.files,
      dolbySidecar
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

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    await handleAsset(url.pathname, res);
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
      ".mov": "video/quicktime"
    }[ext] || "application/octet-stream"
  );
}

function cacheControl(filePath) {
  return path.extname(filePath).toLowerCase() === ".m3u8"
    ? "no-cache, no-store, must-revalidate"
    : "public, max-age=86400";
}
