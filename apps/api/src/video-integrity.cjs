const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function createRpuHasher() {
  const hash = crypto.createHash("sha256");
  let pending = Buffer.alloc(0);
  let count = 0;
  function nal(bytes) {
    // Dolby Vision RPU is HEVC UNSPEC62. Framing bytes are not part of its payload.
    if (bytes.length >= 3 && ((bytes[0] >> 1) & 63) === 62) {
      const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
      hash.update(size); hash.update(bytes); count++;
    }
  }
  function consume(final = false) {
    const starts = [];
    for (let i = 0; i + 2 < pending.length; i++) {
      if (pending[i] === 0 && pending[i + 1] === 0 && pending[i + 2] === 1) {
        starts.push({ start: i > 0 && pending[i - 1] === 0 ? i - 1 : i, payload: i + 3 });
        i += 2;
      }
    }
    for (let i = 0; i + 1 < starts.length; i++) nal(pending.subarray(starts[i].payload, starts[i + 1].start));
    if (final && starts.length) nal(pending.subarray(starts.at(-1).payload));
    pending = final ? Buffer.alloc(0) : starts.length ? pending.subarray(starts.at(-1).start) : pending;
    if (pending.length > 64 * 1024 * 1024) throw new Error("HEVC NAL exceeds integrity scanner limit.");
  }
  return {
    write(chunk) { pending = Buffer.concat([pending, chunk]); consume(); },
    finish() { consume(true); return { count, sha256: hash.digest("hex") }; }
  };
}

function hashDolbyRpu(ffmpeg, input, { cwd, timeoutMs = 3600000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const scanner = createRpuHasher();
    const child = spawn(ffmpeg, ["-v", "error", "-nostdin", "-i", input, "-map", "0:v:0",
      "-c:v", "copy", "-bsf:v", "hevc_mp4toannexb", "-f", "hevc", "pipe:1"], { cwd, windowsHide: true });
    let failure;
    let stderr = "";
    // Cancellation must stop the full-stream verifier too, not just the encoder.
    const abort = () => { failure = signal.reason; child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { failure = new Error("Dolby RPU integrity scan timed out."); child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", chunk => { if (failure) return; try { scanner.write(chunk); } catch (error) { failure = error; child.kill("SIGKILL"); } });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) return reject(failure || new Error(`Dolby RPU scan failed: ${stderr}`));
      try { resolve(scanner.finish()); } catch (error) { reject(error); }
    });
  });
}

function canonicalMetadata(value) {
  if (Array.isArray(value)) return value.map(canonicalMetadata);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter(key => key !== "side_data_type").map(key => [key, canonicalMetadata(value[key])]));
  // Equivalent ffprobe rationals must compare equally across container formats.
  if (typeof value === "string" && /^-?\d+\/\d+$/.test(value)) {
    const [a, b] = value.split("/").map(Number);
    return b ? a / b : value;
  }
  return value;
}

function compareHdrMetadata(source, output) {
  const errors = [];
  for (const field of ["masteringDisplay", "contentLightLevel"]) {
    if (JSON.stringify(canonicalMetadata(source.hdrStaticMetadata?.[field] ?? null)) !==
        JSON.stringify(canonicalMetadata(output.hdrStaticMetadata?.[field] ?? null))) errors.push(`output: HDR ${field} changed or was lost.`);
  }
  for (const field of ["profile", "level", "compatibilityId", "rpuPresent", "elPresent", "blPresent", "rpuCount", "rpuSha256"]) {
    if ((source.dolbyMetadata?.[field] ?? null) !== (output.dolbyMetadata?.[field] ?? null)) errors.push(`output: Dolby ${field} changed or was lost.`);
  }
  return errors;
}

module.exports = { createRpuHasher, hashDolbyRpu, compareHdrMetadata };
