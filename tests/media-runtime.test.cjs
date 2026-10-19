const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { mediaThreadArgs } = require("../apps/api/src/resource-io.cjs");
const exec = promisify(execFile);

test("thread-limited real FFmpeg encoding and FFprobe retain video dimensions and color tags", async t => {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  try { await exec(ffmpeg, ["-version"]); await exec(ffprobe, ["-version"]); }
  catch (error) { if (error.code === "ENOENT") return t.skip("System FFmpeg/FFprobe not installed"); throw error; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-ffmpeg-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, "sample.mp4");
  // Tiny synthetic input validates real option placement, never user media or CMS data.
  await exec(ffmpeg, mediaThreadArgs(["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=32x32:r=5,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    "-frames:v", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_primaries", "bt709",
    "-color_trc", "bt709", "-colorspace", "bt709", output], 1), { timeout: 10000 });
  const { stdout } = await exec(ffprobe, mediaThreadArgs(["-v", "error", "-show_streams", "-of", "json", output], 1, true));
  const stream = JSON.parse(stdout).streams[0];
  assert.equal(stream.width, 32); assert.equal(stream.height, 32);
  assert.equal(stream.color_primaries, "bt709"); assert.equal(stream.color_transfer, "bt709");
  assert.equal(stream.codec_name, "h264");
});
