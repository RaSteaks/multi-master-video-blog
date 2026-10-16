const fs = require("node:fs/promises");
const path = require("node:path");

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function denied() {
  return Object.assign(new Error("Media file not found."), { statusCode: 404 });
}

// Keep the persisted film-scans/... namespace stable across storage moves and OSes.
function filmScanPath(root, storedPath) {
  const parts = String(storedPath || "").replace(/\\/g, "/").split("/");
  if (parts.shift() !== "film-scans" || !parts.length ||
      parts.some(part => !part || part === "." || part === ".." || /[:\0]/.test(part))) {
    throw new Error("Invalid private film-scan path.");
  }
  const target = path.resolve(root, ...parts);
  if (!inside(root, target)) throw new Error("Invalid private film-scan path.");
  return target;
}

function filmScanStoredPath(root, filename) {
  if (!inside(root, filename) || root === filename) throw new Error("Invalid private film-scan path.");
  return `film-scans/${path.relative(root, filename).split(path.sep).join("/")}`;
}

async function exists(filename) {
  try { await fs.lstat(filename); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function prepareFilmScanStorage(mediaRoot, privateRoot) {
  if (inside(mediaRoot, privateRoot) || inside(privateRoot, mediaRoot)) {
    throw new Error("FILM_SCAN_ROOT must be outside and separate from MEDIA_ROOT.");
  }
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(privateRoot, { recursive: true });
  const mediaReal = await fs.realpath(mediaRoot);
  const privateReal = await fs.realpath(privateRoot);
  if (inside(mediaReal, privateReal) || inside(privateReal, mediaReal)) {
    throw new Error("FILM_SCAN_ROOT must not resolve into the public media tree.");
  }
  const legacy = path.join(mediaRoot, "film-scans");
  if (!await exists(legacy)) return;
  if ((await fs.lstat(legacy)).isSymbolicLink()) {
    throw new Error("Refusing to migrate a symbolic-link film-scan directory.");
  }
  // Numeric children are scan jobs. Older videos could legitimately use the
  // film-scans slug and have source/sdr/hdr* children; leave those public files intact.
  const entries = (await fs.readdir(legacy, { withFileTypes: true }))
    .filter(entry => /^[1-9]\d*$/.test(entry.name));
  // Preflight every destination: never overwrite tasks or discard a rollback ledger.
  for (const entry of entries) {
    if (entry.isSymbolicLink() || await exists(path.join(privateRoot, entry.name))) {
      throw new Error(`Film-scan migration conflict: ${entry.name}. Resolve it before starting the API.`);
    }
  }
  for (const entry of entries) {
    try { await fs.rename(path.join(legacy, entry.name), path.join(privateRoot, entry.name)); }
    catch (error) {
      if (error.code === "EXDEV") {
        throw new Error("Film-scan storage is on another volume. Move the remaining legacy files to FILM_SCAN_ROOT before restarting.");
      }
      throw error;
    }
  }
  if (!(await fs.readdir(legacy)).length) await fs.rmdir(legacy);
}

async function publicMediaPath(mediaRoot, privateRoot, requestPath) {
  const relative = decodeURIComponent(requestPath).replace(/\\/g, "/");
  // Reject Windows aliases (ADS/trailing dots) as well as encoded separators.
  const parts = relative.split("/");
  if (/[:\0]/.test(relative) || parts.some(part => /[. ]$/.test(part)) ||
      (parts[0]?.toLowerCase() === "film-scans" && /^[1-9]\d*$/.test(parts[1] || ""))) throw denied();
  const candidate = path.resolve(mediaRoot, relative);
  if (!inside(mediaRoot, candidate)) throw denied();
  const [rootReal, fileReal] = await Promise.all([fs.realpath(mediaRoot), fs.realpath(candidate)]);
  // Resolve links/NTFS aliases before serving, so another public name cannot expose private files.
  const realParts = path.relative(rootReal, fileReal).split(path.sep);
  if (!inside(rootReal, fileReal) ||
      (realParts[0]?.toLowerCase() === "film-scans" && /^[1-9]\d*$/.test(realParts[1] || ""))) throw denied();
  if (await exists(privateRoot) && inside(await fs.realpath(privateRoot), fileReal)) throw denied();
  return fileReal;
}

function assetSafetyHeaders(contentType) {
  const type = String(contentType || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  const inline = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
  // Never inherit an active document's origin privileges, including files uploaded before this fix.
  return {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'",
    "Content-Disposition": inline.has(type) ? "inline" : "attachment"
  };
}

module.exports = { filmScanPath, filmScanStoredPath, prepareFilmScanStorage, publicMediaPath, assetSafetyHeaders };
