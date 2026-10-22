const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise production functions without starting a server or contacting the real CMS.
function loadServer(root, ffmpeg, ffprobe) {
  const source = fs.readFileSync(path.join(__dirname, "../../src/server.cjs"), "utf8");
  const api = vm.createContext({
    ...require("../../src/imf.cjs"), ...require("../../src/video-sdr.cjs"),
    ...require("../../../../shared/video-source-format.cjs"),
    ...require("../../src/video-integrity.cjs"), ...require("../../src/hls-metadata.cjs"),
    ...require("../../src/multipart-utils.cjs"),
    // VM fixtures share the production resource and cross-volume upload adapters.
    ...require("../../src/resource-io.cjs"),
    mediaContext: new (require("node:async_hooks").AsyncLocalStorage)(),
    resourceLimits: require("../../../../config/resource-profile.cjs").resolveResourceProfile({}),
    videoProcessingSlots: require("../../src/task-limiter.cjs").createTaskLimiter(),
    fs, fsp: fs.promises, path, crypto: require("node:crypto"), spawn: require("node:child_process").spawn,
    setTimeout, clearTimeout, URLSearchParams, Buffer,
    ROOT: root, REPO_ROOT: root, MEDIA_ROOT: root, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe,
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_LEGACY_UPLOAD_BYTES: 20 * 1024 * 1024,
    // Shared storage/admission has its own focused suite; retain real media processing here.
    legacyUploadSlots: { acquire: async () => () => {} },
    videoUploads: { reserveLegacy: async () => () => {} },
    VIDEO_PROCESS_TIMEOUT_MS: 3600000, VIDEO_SDR_PROCESS_TIMEOUT_MS: 3600000,
    HDR_MASTER_TYPES: new Set(["hdr10", "hlg", "dolby_vision"]),
    TRANSCODE_TYPES: new Set(["sdr", "custom"]),
    COLOR_REQUIRED_FIELDS: ["colorPrimaries", "colorTransfer", "matrixCoefficients", "colorRange", "pixelFormat", "bitDepth", "chromaLocation"]
  });
  vm.runInContext("let videoSdrFiltersPromise = null;\n" + source.match(/^(?:async )?function \w+\([\s\S]*?^}/gm).join("\n"), api);
  return api;
}

module.exports = { loadServer };
