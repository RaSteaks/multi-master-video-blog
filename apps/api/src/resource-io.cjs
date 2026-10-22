const fsp = require("node:fs/promises");
const { constants } = require("node:fs");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// Apply decoder options before each input and encoder options before each output.
function mediaThreadArgs(args, threads, probe = false) {
  if (!threads || args.includes("-version") || args.includes("-filters")) return args;
  const options = ["-threads", String(threads)];
  if (probe) return [...options, ...args];
  const result = ["-filter_threads", String(threads), "-filter_complex_threads", String(threads)];
  for (const arg of args) {
    if (arg === "-i") result.push(...options);
    result.push(arg);
  }
  // IMF uses libx265's own pools; FFmpeg -threads alone does not bound them.
  if (result.includes("libx265")) {
    const index = result.indexOf("-x265-params");
    const parameters = index < 0 ? [] : result[index + 1].split(":")
      .filter(value => !/^(pools|frame-threads)=/.test(value));
    parameters.push(`pools=${threads}`, `frame-threads=${threads}`);
    if (index < 0) result.splice(result.length - 1, 0, "-x265-params", parameters.join(":"));
    else result[index + 1] = parameters.join(":");
  }
  // All application encode commands have a single final output; copies keep their codec.
  result.splice(result.length - 1, 0, ...options);
  return result;
}

async function downloadToFile(response, targetPath, maxBytes) {
  const oversized = () => Object.assign(new Error("The existing SDR photo exceeds the validation limit."), { statusCode: 413 });
  let bytes = 0;
  let output;
  try {
    if (Number(response.headers.get("content-length")) > maxBytes) throw oversized();
    if (!response.body) throw new Error("Asset response has no body.");
    // Establish ownership before consuming the stream, including on size-limit failure.
    output = await fsp.open(targetPath, "wx");
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, encoding, done) {
        bytes += chunk.length;
        done(bytes > maxBytes ? oversized() : null, chunk);
      }
    }), output.createWriteStream());
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    // Callers provide a fresh temporary path; EEXIST must preserve its owner.
    if (output) {
      await output.close().catch(() => {});
      await fsp.rm(targetPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

// Docker can place the private spool and media on separate mounts. Preserve bytes
// and remove the staging link only after a complete copy has reached the destination.
async function moveUploadFile(source, destination) {
  try { await fsp.rename(source, destination); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    let copied = false;
    try {
      await fsp.copyFile(source, destination, constants.COPYFILE_EXCL);
      copied = true;
      const output = await fsp.open(destination, "r+");
      try { await output.sync(); } finally { await output.close(); }
      await fsp.unlink(source);
    } catch (copyError) {
      if (copied) await fsp.rm(destination, { force: true }).catch(() => {});
      throw copyError;
    }
  }
}

module.exports = { mediaThreadArgs, downloadToFile, moveUploadFile };
