const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

/** One bounded intermediate per private job; final exports never use this cache. */
async function prepareCachedPreview(options, prepare, maxBytes = 64 * 1024 ** 2) {
  const stat = await fs.stat(options.sourcePath);
  const signature = crypto.createHash("sha256").update(JSON.stringify({
    source: options.sourcePath, size: stat.size, mtime: stat.mtimeMs,
    crop: options.crop, rotation: options.rotation, mask: options.adjustments?.maskRgb,
    filmType: options.filmType, pipeline: 1
  })).digest("hex");
  const cached = path.join(options.tempDir, ".review-density.tif");
  const journal = path.join(options.tempDir, ".review-density.json");
  try {
    if (JSON.parse(await fs.readFile(journal, "utf8")).signature === signature && (await fs.stat(cached)).size <= maxBytes) {
      return { sourcePath: cached, crop: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0, filmType: "slide", temporaryPaths: [] };
    }
  } catch (error) { if (!['ENOENT', 'SyntaxError'].includes(error.code || error.name)) throw error; }
  const prepared = await prepare(options);
  if ((await fs.stat(prepared.sourcePath)).size > maxBytes) return prepared;
  try {
    // Invalidate first: an interrupted replacement must never pair old metadata with new pixels.
    await fs.rm(journal, { force: true });
    await fs.rename(prepared.sourcePath, cached);
    await fs.writeFile(journal, JSON.stringify({ signature }));
    return { ...prepared, sourcePath: cached, temporaryPaths: prepared.temporaryPaths.filter(file => file !== prepared.sourcePath) };
  } catch (error) {
    for (const file of prepared.temporaryPaths) await fs.rm(file, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { prepareCachedPreview };
