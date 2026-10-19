const { execFileSync } = require("node:child_process");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
// Check compiled capabilities at build time; a Vulkan device is checked by real jobs.
const read = args => execFileSync(ffmpeg, ["-hide_banner", ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const probeVersion = execFileSync(ffprobe, ["-version"], { encoding: "utf8" }).match(/^ffprobe version (\S+)/)?.[1];
const encodeVersion = read(["-version"]).match(/^ffmpeg version (\S+)/)?.[1];
if (!probeVersion || probeVersion !== encodeVersion) throw new Error("Use matched FFmpeg/FFprobe versions.");
const filters = read(["-filters"]), encoders = read(["-encoders"]), decoders = read(["-decoders"]);
for (const decoder of ["h264", "hevc", "av1", "aac", "jpeg2000"]) if (!decoders.includes(decoder)) throw new Error(`FFmpeg lacks ${decoder} decoding`);
for (const filter of ["libplacebo", "zscale"]) if (!filters.includes(filter)) throw new Error(`FFmpeg lacks ${filter}`);
for (const encoder of ["libx264", "libx265", "libaom-av1", "aac", "tiff"]) if (!encoders.includes(encoder)) throw new Error(`FFmpeg lacks ${encoder}`);
if (!read(["-h", "filter=libplacebo"]).includes("apply_dolbyvision")) throw new Error("libplacebo lacks apply_dolbyvision");
console.log("FFmpeg/FFprobe capabilities verified. Vulkan device availability is a runtime requirement.");
