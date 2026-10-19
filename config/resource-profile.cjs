const os = require("node:os");
const fs = require("node:fs");
const { parseEnv } = require("node:util");

const PROFILES = {
  "low-2gb": { threads: 1, sharpCache: 16, pixels: 24_000_000, web: 256, api: 256, cms: 384, build: 1024, pool: 3 },
  "low-4gb": { threads: 2, sharpCache: 32, pixels: 48_000_000, web: 384, api: 512, cms: 768, build: 1536, pool: 5 }
};

// Service-manager/container values deliberately override local development files.
function loadEnvironment(filename, environment = process.env) {
  return { ...(fs.existsSync(filename) ? parseEnv(fs.readFileSync(filename, "utf8")) : {}), ...environment };
}

function integer(env, key, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = Number(env[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function resolveResourceProfile(env = process.env, cores = os.availableParallelism()) {
  const name = env.RESOURCE_PROFILE || "default";
  if (name !== "default" && !PROFILES[name]) throw new Error(`Unknown RESOURCE_PROFILE: ${name}`);
  const defaults = PROFILES[name];
  if (integer(env, "DB_POOL__MIN", defaults ? 0 : 2, 0) > integer(env, "DB_POOL__MAX", defaults?.pool ?? 10)) {
    throw new Error("DB_POOL__MIN must not exceed DB_POOL__MAX.");
  }
  return Object.freeze({
    name, enabled: Boolean(defaults),
    mediaConcurrency: integer(env, "MEDIA_PROCESS_CONCURRENCY", 1),
    maxPending: integer(env, "MEDIA_PROCESS_MAX_PENDING", 4, 0),
    queueTimeoutMs: integer(env, "MEDIA_PROCESS_QUEUE_TIMEOUT_MS", 60000),
    ffmpegThreads: Math.min(cores, integer(env, "FFMPEG_THREADS", defaults?.threads ?? 0, 0)),
    tuneSharp: Boolean(defaults) || env.SHARP_CACHE_MIB !== undefined || env.SHARP_CONCURRENCY !== undefined,
    sharpConcurrency: integer(env, "SHARP_CONCURRENCY", defaults ? 1 : 0, 0),
    sharpCacheMiB: integer(env, "SHARP_CACHE_MIB", defaults?.sharpCache ?? 50, 0),
    maxPixels: integer(env, "FILM_SCAN_MAX_PIXELS", defaults?.pixels ?? 800_000_000),
    processOutputBytes: integer(env, "PROCESS_MAX_OUTPUT_BYTES", 16 * 1024 * 1024),
    processLogBytes: integer(env, "PROCESS_MAX_LOG_BYTES", 64 * 1024),
    buildWorkers: integer(env, "BUILD_WORKERS", defaults ? 1 : 2),
    heap: Object.fromEntries(["web", "api", "cms", "build"].map(service => [service,
      integer(env, `${service.toUpperCase()}_HEAP_MIB`, defaults?.[service] ?? 0, 0)])),
    dbPoolMax: integer(env, "DB_POOL__MAX", defaults?.pool ?? 10),
    dbPoolMin: integer(env, "DB_POOL__MIN", defaults ? 0 : 2, 0),
    assetConcurrency: integer(env, "ASSETS_TRANSFORM_MAX_CONCURRENT", defaults ? 1 : 25)
  });
}

module.exports = { loadEnvironment, resolveResourceProfile, integer };
