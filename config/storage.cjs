const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { loadEnvironment } = require("./resource-profile.cjs");

function contentStorageConfig(env) {
  const locations = (env.STORAGE_LOCATIONS || "local").split(",").map(value => value.trim()).filter(Boolean);
  if (locations[0] !== "oss") return null;
  if (env.STORAGE_OSS_DRIVER !== "s3") throw new Error("Unified OSS storage requires STORAGE_OSS_DRIVER=s3.");
  for (const name of ["BUCKET", "REGION", "ENDPOINT", "KEY", "SECRET"]) {
    if (!env[`STORAGE_OSS_${name}`]?.trim()) throw new Error(`STORAGE_OSS_${name} is required when oss is the default storage location.`);
  }
  const endpoint = new URL(env.STORAGE_OSS_ENDPOINT);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("STORAGE_OSS_ENDPOINT must be an HTTP(S) service origin.");
  const root = (env.STORAGE_OSS_ROOT || "").replace(/^\/+|\/+$/g, "");
  if (root && (root.includes("\\") || root.split("/").some(part => !part || part === "." || part === ".."))) {
    throw new Error("STORAGE_OSS_ROOT must be an object prefix without traversal.");
  }
  return { bucket: env.STORAGE_OSS_BUCKET, region: env.STORAGE_OSS_REGION, endpoint: endpoint.origin,
    root, key: env.STORAGE_OSS_KEY, secret: env.STORAGE_OSS_SECRET };
}

/** One public configuration feeds Directus adapters and API video/content storage. */
function configureStorage(env) {
  const config = contentStorageConfig(env);
  if (!config) return env;
  const prefix = config.root ? `${config.root}/` : "";
  const settings = { ...env, VIDEO_STORAGE: "oss", VIDEO_OSS_BUCKET: config.bucket,
    VIDEO_OSS_REGION: config.region, VIDEO_OSS_ENDPOINT: config.endpoint,
    VIDEO_OSS_ROOT: `${prefix}videos`, VIDEO_OSS_KEY: config.key, VIDEO_OSS_SECRET: config.secret };
  const locations = (env.STORAGE_LOCATIONS || "oss,local").split(",").map(value => value.trim()).filter(Boolean);
  // Keep the deployed default location/order and append category adapters only.
  settings.STORAGE_LOCATIONS = [...new Set(["oss", ...locations, "local", "oss_article", "oss_album", "oss_video"])].join(",");
  for (const [location, root] of [
    ["OSS_ARTICLE", `${prefix}article/assets`],
    ["OSS_ALBUM", `${prefix}album/assets`],
    ["OSS_VIDEO", `${prefix}videos/assets`]
  ]) {
    for (const [name, value] of Object.entries({ DRIVER: "s3", BUCKET: config.bucket, REGION: config.region,
      ENDPOINT: config.endpoint, ROOT: root, KEY: config.key, SECRET: config.secret })) {
      settings[`STORAGE_${location}_${name}`] = value;
    }
  }
  return settings;
}

function loadStorageEnvironment(filename, environment = process.env, sharedFilename) {
  const service = loadEnvironment(filename, environment);
  if (environment.STORAGE_LOCATIONS !== undefined && environment.STORAGE_LOCATIONS.split(",")[0].trim() !== "oss") {
    return configureStorage(service);
  }
  const cmsFilename = sharedFilename || service.CMS_ENV_FILE || path.join(__dirname, "../apps/cms/directus/.env");
  if ((sharedFilename || service.CMS_ENV_FILE) && !fs.existsSync(cmsFilename)) {
    throw new Error("CMS_ENV_FILE does not exist; refusing to fall back to local content storage.");
  }
  const shared = fs.existsSync(cmsFilename) ? parseEnv(fs.readFileSync(cmsFilename, "utf8")) : {};
  // Read only storage settings from the CMS file. Its port, database/admin
  // credentials and other service settings must never override the API's own.
  const storageSettings = values => Object.fromEntries(Object.entries(values).filter(([name]) =>
    name.startsWith("STORAGE_")));
  return configureStorage({ ...service, ...storageSettings(shared), ...storageSettings(environment) });
}

module.exports = { configureStorage, contentStorageConfig, loadStorageEnvironment };
