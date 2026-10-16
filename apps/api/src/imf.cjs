const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream } = require("node:fs");
const crypto = require("node:crypto");
const { SaxesParser } = require("saxes");

function fail(message) {
  throw Object.assign(new Error(`IMF: ${message}`), { statusCode: 422 });
}

// Parse structure, not regex matches: CPL descriptors and resources are linked by UUID.
// DTDs/entities, unbounded trees and ambiguous singleton fields are never accepted.
function parseXml(text) {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail("XML exceeds the 2 MiB limit.");
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let root, count = 0;
  parser.on("doctype", () => fail("XML document types are not supported."));
  parser.on("error", () => fail("Malformed XML."));
  parser.on("opentag", tag => {
    if (++count > 30000 || stack.length >= 64) fail("XML structure exceeds limits.");
    const node = { name: tag.local, namespace: tag.uri, children: [], text: "" };
    if (stack.length) stack.at(-1).children.push(node);
    else root = node;
    stack.push(node);
  });
  const textEvent = value => { if (stack.length) stack.at(-1).text += value; };
  parser.on("text", textEvent);
  parser.on("cdata", textEvent);
  parser.on("closetag", () => stack.pop());
  parser.write(text).close();
  if (!root) fail("Empty XML.");
  return root;
}
const children = (node, name) => (node?.children || []).filter(child => child.name === name);
function one(node, name, required = true) {
  const found = children(node, name);
  if (found.length > 1 || (required && !found.length)) fail(`Expected one ${name}.`);
  return found[0];
}
const value = (node, name, fallback) => one(node, name, fallback === undefined)?.text.trim() ?? fallback;
function integer(node, name, fallback) {
  const text = value(node, name, fallback);
  if (!/^\d+$/.test(String(text)) || !Number.isSafeInteger(Number(text))) fail(`Invalid ${name}.`);
  return Number(text);
}
function ratio(text) {
  const parts = String(text).trim().split(/[\s/]+/).map(Number);
  if (parts.length !== 2 || parts.some(n => !Number.isSafeInteger(n) || n <= 0)) fail("Invalid rational rate/aspect ratio.");
  return parts[0] / parts[1];
}
function probeRate(probe) {
  // MXF demuxers can report avg_frame_rate=0/0 while retaining a valid edit rate.
  return ratio(probe.avg_frame_rate && probe.avg_frame_rate !== "0/0" ? probe.avg_frame_rate : probe.r_frame_rate);
}
function uuid(text) {
  const id = String(text).toLowerCase();
  if (!/^urn:uuid:[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(id)) fail("Invalid asset/descriptor UUID.");
  return id;
}
function relativePath(text, uri = true) {
  // ASSETMAP paths are URI references, resolved only against the uploaded file set.
  let decoded;
  try { decoded = uri ? decodeURIComponent(text) : text; } catch { fail("Invalid asset path encoding."); }
  if (!decoded || /[\\\x00-\x1f?#:]/.test(decoded) || decoded.startsWith("/") ||
      decoded.split("/").some(part => part === ".." || part === "")) fail("Unsafe asset path.");
  return path.posix.normalize(decoded);
}

async function xmlRootInfo(filePath) {
  // Inspect only a bounded prefix of unrelated Dolby XML sidecars; they can be
  // much larger than a CPL and must retain the pre-existing non-IMF upload path.
  const file = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const parser = new SaxesParser({ xmlns: true });
    let name = null;
    const stop = new Error("root found");
    parser.on("doctype", () => { throw stop; });
    parser.on("opentag", tag => { name = { name: tag.local, namespace: tag.uri }; throw stop; });
    parser.on("error", () => { throw stop; });
    try { parser.write(buffer.subarray(0, bytesRead).toString("utf8")); } catch (error) { if (error !== stop) throw error; }
    return name;
  } finally { await file.close(); }
}
async function xmlRootName(filePath) {
  return (await xmlRootInfo(filePath))?.name || null;
}
function colorUl(text, kind) {
  const hex = text.toLowerCase().replace(/^urn:smpte:ul:/, "").replace(/\./g, "");
  if (!/^060e2b34040101[\da-f]{2}04010101[\da-f]{8}$/.test(hex)) fail(`Unsupported ${kind} UL.`);
  // SMPTE registry version is independent of the identifier. Use the mappings
  // in FFmpeg libavformat/mxf.c, not display labels or Resolve preset names.
  const map = kind === "primaries"
    ? { "03010000": "smpte170m", "03020000": "bt470bg", "03030000": "bt709", "03040000": "bt2020", "03050000": "smpte428", "03060000": "smpte432", "030a0000": "smpte431" }
    : { "01010000": "gamma22", "01020000": "bt709", "01030000": "smpte240m", "01040000": "bt709", "01060000": "linear", "01070000": "smpte428", "01090000": "bt2020-10", "010a0000": "smpte2084", "010b0000": "arib-std-b67" };
  return map[hex.slice(24)] || fail(`Unsupported ${kind} UL.`);
}

async function inspectRgbImfPackage(files) {
  const xml = [];
  const originals = new Map();
  for (const file of files) {
    const original = relativePath(String(file.filename).replace(/\\/g, "/"), false);
    if (originals.has(original)) fail("Duplicate uploaded package path.");
    originals.set(original, file);
    if (/\.xml$|(?:^|\/)ASSETMAP$/i.test(original)) {
      const rootName = await xmlRootName(file.packagePath);
      if (!["CompositionPlaylist", "AssetMap"].includes(rootName) && !/^(?:CPL.*\.xml|ASSETMAP(?:\.xml)?)$/i.test(path.posix.basename(original))) continue;
      if ((await fs.stat(file.packagePath)).size > 2 * 1024 * 1024) fail("XML exceeds the 2 MiB limit.");
      xml.push({ file, original, root: parseXml(await fs.readFile(file.packagePath, "utf8")) });
    }
  }
  const cpls = xml.filter(item => item.root.name === "CompositionPlaylist");
  const maps = xml.filter(item => item.root.name === "AssetMap");
  if (!cpls.length && !maps.length) return null;
  if (cpls.length !== 1 || maps.length !== 1) fail("Upload one complete IMF composition with one CPL and one ASSETMAP.");
  const { root: cpl } = cpls[0];
  const assets = new Map();
  for (const asset of children(one(maps[0].root, "AssetList"), "Asset")) {
    const id = uuid(value(asset, "Id"));
    if (assets.has(id)) fail("Duplicate ASSETMAP asset UUID.");
    const chunk = one(one(asset, "ChunkList"), "Chunk");
    if (integer(chunk, "Offset", "0") !== 0 || integer(chunk, "VolumeIndex", "1") !== 1) fail("Split/offset assets are not supported.");
    const uri = relativePath(value(chunk, "Path"));
    const file = originals.get(path.posix.join(path.posix.dirname(maps[0].original), uri));
    if (!file) fail(`Missing uploaded asset: ${uri}`);
    if (integer(chunk, "Length") !== (await fs.stat(file.packagePath)).size) fail(`Asset length mismatch: ${uri}`);
    assets.set(id, file.packagePath);
  }
  const descriptors = new Map();
  for (const descriptor of children(one(cpl, "EssenceDescriptorList"), "EssenceDescriptor")) {
    const id = uuid(value(descriptor, "Id"));
    if (descriptors.has(id)) fail("Duplicate essence descriptor UUID.");
    descriptors.set(id, descriptor);
  }
  const sequences = one(one(one(cpl, "SegmentList"), "Segment"), "SequenceList");
  if (sequences.children.some(node => !["MainImageSequence", "MainAudioSequence", "ISXDSequence", "MarkerSequence"].includes(node.name))) {
    fail("Unsupported composition sequence; flatten the composition before upload.");
  }
  const frameRate = ratio(value(cpl, "EditRate"));
  function resource(sequence) {
    const node = one(one(sequence, "ResourceList"), "Resource");
    const rate = ratio(value(node, "EditRate", value(cpl, "EditRate")));
    const entry = integer(node, "EntryPoint", "0");
    const intrinsic = integer(node, "IntrinsicDuration");
    const duration = integer(node, "SourceDuration", String(intrinsic - entry));
    if (integer(node, "RepeatCount", "1") !== 1 || !duration || entry + duration > intrinsic) fail("Invalid/repeated resource; flatten the composition before upload.");
    const file = assets.get(uuid(value(node, "TrackFileId")));
    const descriptor = descriptors.get(uuid(value(node, "SourceEncoding")));
    if (!file || !descriptor) fail("Resource does not resolve to an uploaded asset and descriptor.");
    return { path: file, descriptor, rate, entry, duration, seconds: duration / rate, start: entry / rate };
  }
  const video = resource(one(sequences, "MainImageSequence"));
  if (Math.abs(video.rate - frameRate) > 1e-7) fail("Image edit rate differs from composition edit rate.");
  const audioSequence = one(sequences, "MainAudioSequence", false);
  const audio = audioSequence ? resource(audioSequence) : null;
  if (audio) {
    const sound = one(audio.descriptor, "WAVEPCMDescriptor");
    audio.channels = integer(sound, "ChannelCount", "0") || null;
    audio.sampleRate = one(sound, "AudioSampleRate", false) ? ratio(value(sound, "AudioSampleRate")) : null;
  }
  if (audio && Math.abs(video.seconds - audio.seconds) > 1 / frameRate) fail("Image and audio composition durations differ.");
  const dolbySequences = children(sequences, "ISXDSequence");
  const hasDolbyMetadata = dolbySequences.map(resource).some(item => {
    // ISXD can carry other XML schemas; only the Dolby namespace identifies DV metadata.
    const data = one(item.descriptor, "ISXDDataEssenceDescriptor", false);
    return /^https?:\/\/www\.dolby\.com\/schemas\/dvmd-fw\//.test(value(data, "NamespaceURI", ""));
  });
  const descriptor = one(video.descriptor, "RGBADescriptor");
  if (value(descriptor, "FrameLayout", "FullFrame") !== "FullFrame" ||
      value(descriptor, "ScanningDirection", "ScanningDirection_LeftToRightTopToBottom") !== "ScanningDirection_LeftToRightTopToBottom") fail("Only progressive, top-left RGB images are supported.");
  const layout = children(one(descriptor, "PixelLayout"), "RGBAComponent");
  if (layout.some(node => !["CompRed", "CompGreen", "CompBlue", "CompFill", "CompNull"].includes(value(node, "Code")))) fail("Alpha/auxiliary components require a flattened RGB export.");
  const components = layout
    .filter(node => ["CompRed", "CompGreen", "CompBlue"].includes(value(node, "Code")));
  const depths = components.map(node => integer(node, "ComponentSize"));
  if (components.length !== 3 || new Set(components.map(node => value(node, "Code"))).size !== 3 ||
      new Set(depths).size !== 1 || ![10, 12, 16].includes(depths[0])) fail("Expected 10/12/16-bit RGB components.");
  const depth = depths[0];
  const min = integer(descriptor, "ComponentMinRef");
  const max = integer(descriptor, "ComponentMaxRef");
  if (min !== 0 || max !== 2 ** depth - 1) fail("Only explicitly full-range RGB IMF is supported.");
  const primaries = colorUl(value(descriptor, "ColorPrimaries"), "primaries");
  const transfer = colorUl(value(descriptor, "TransferCharacteristic"), "transfer");
  if (transfer !== "smpte2084" || !["bt2020", "smpte432"].includes(primaries)) fail("RGB IMF playback currently requires PQ with BT.2020 or P3-D65 primaries.");
  const width = integer(descriptor, "StoredWidth"), height = integer(descriptor, "StoredHeight");
  const crop = {
    x: integer(descriptor, "DisplayXOffset", "0"), y: integer(descriptor, "DisplayYOffset", "0"),
    width: integer(descriptor, "DisplayWidth", String(width)), height: integer(descriptor, "DisplayHeight", String(height))
  };
  if (!width || !height || !crop.width || !crop.height || crop.x + crop.width > width || crop.y + crop.height > height ||
      crop.width % 2 || crop.height % 2) fail("Invalid display window for 4:2:0 delivery.");
  if (Math.abs(ratio(value(descriptor, "ImageAspectRatio")) - crop.width / crop.height) > 0.001) fail("Non-square display pixels are not supported.");
  const displayPrimaries = children(one(descriptor, "MasteringDisplayPrimaries"), "ColorPrimary");
  if (displayPrimaries.length !== 3) fail("Missing mastering display primaries.");
  const xy = node => {
    const x = integer(node, "X"), y = integer(node, "Y");
    if (x > 50000 || y > 50000 || x + y > 50000) fail("Invalid mastering chromaticity.");
    return [x, y];
  };
  const mastering = {
    red: xy(displayPrimaries[0]), green: xy(displayPrimaries[1]), blue: xy(displayPrimaries[2]),
    white: xy(one(descriptor, "MasteringDisplayWhitePointChromaticity")),
    min: integer(descriptor, "MasteringDisplayMinimumLuminance"),
    max: integer(descriptor, "MasteringDisplayMaximumLuminance")
  };
  if (mastering.max <= mastering.min || mastering.max > 100000000) fail("Invalid mastering luminance.");
  const extensions = one(cpl, "ExtensionProperties");
  const maxCLL = integer(extensions, "MaxCLL"), maxFALL = integer(extensions, "MaxFALL");
  if (maxCLL > 10000 || maxFALL > maxCLL) fail("Invalid MaxCLL/MaxFALL.");
  return { cplId: uuid(value(cpl, "Id")), cplPath: cpls[0].file.packagePath,
    video, audio, frameRate, depth, primaries, transfer, width, height, crop, mastering,
    maxCLL, maxFALL, hasDolbyMetadata };
}

async function hashImfPackage(files) {
  // Audio, CPL edits and dynamic metadata also identify the source. Hashing only
  // JPEG 2000 would incorrectly retain old SDR after an audio/timeline overwrite.
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((a, b) => a.filename.localeCompare(b.filename, "en"))) {
    const stat = await fs.stat(file.packagePath);
    hash.update(JSON.stringify([file.filename, stat.size]) + "\n");
    for await (const chunk of createReadStream(file.packagePath)) hash.update(chunk);
  }
  return hash.digest("hex");
}

function applyImfColor(imf, probe, audioProbe) {
  const known = value => value && !["unknown", "unspecified", "N/A"].includes(value);
  if (probe.codec_name !== "jpeg2000" || !/^(?:rgb48[bl]e|gbrp(?:10|12|16)[bl]e)$/.test(probe.pix_fmt || "")) fail("The CPL RGB track must decode as high-bit-depth JPEG 2000 RGB without alpha.");
  for (const [key, expected] of Object.entries({ color_primaries: imf.primaries, color_transfer: imf.transfer,
    width: imf.width, height: imf.height, bits_per_raw_sample: imf.depth })) {
    if (known(probe[key]) && String(probe[key]) !== String(expected)) fail(`CPL conflicts with video ${key}.`);
  }
  if (known(probe.color_range) && !["pc", "full"].includes(probe.color_range)) fail("CPL conflicts with video color range.");
  if (known(probe.color_space) && !["gbr", "rgb"].includes(probe.color_space)) fail("CPL conflicts with video RGB matrix.");
  if (Math.abs(probeRate(probe) - imf.frameRate) > 1e-7) fail("CPL conflicts with video frame rate.");
  if (Number(probe.duration) + 1 / imf.frameRate < imf.video.start + imf.video.seconds) fail("Video is shorter than the CPL resource.");
  if (imf.audio && (!audioProbe || audioProbe.codec_type !== "audio" ||
      Number(audioProbe.duration) + 1 / imf.frameRate < imf.audio.start + imf.audio.seconds)) fail("Missing/short audio essence.");
  if (imf.audio && ((imf.audio.channels && audioProbe.channels !== imf.audio.channels) ||
      (imf.audio.sampleRate && Number(audioProbe.sample_rate) !== imf.audio.sampleRate))) fail("CPL conflicts with audio channel count/sample rate.");
  const m = imf.mastering;
  const mastering = { side_data_type: "Mastering display metadata",
    red_x: `${m.red[0]}/50000`, red_y: `${m.red[1]}/50000`,
    green_x: `${m.green[0]}/50000`, green_y: `${m.green[1]}/50000`,
    blue_x: `${m.blue[0]}/50000`, blue_y: `${m.blue[1]}/50000`,
    white_point_x: `${m.white[0]}/50000`, white_point_y: `${m.white[1]}/50000`,
    min_luminance: `${m.min}/10000`, max_luminance: `${m.max}/10000` };
  const light = { side_data_type: "Content light level metadata", max_content: imf.maxCLL, max_average: imf.maxFALL };
  const existing = probe.side_data_list || [];
  for (const expected of [mastering, light]) {
    const actual = existing.find(item => item.side_data_type === expected.side_data_type);
    if (!actual) continue;
    for (const [key, val] of Object.entries(expected)) {
      if (key === "side_data_type" || actual[key] === undefined) continue;
      const numeric = v => String(v).includes("/") ? String(v).split("/").map(Number).reduce((a, b) => a / b) : Number(v);
      if (Math.abs(numeric(actual[key]) - numeric(val)) > 1e-7) fail(`CPL conflicts with embedded HDR ${key}.`);
    }
  }
  return { ...probe, color_primaries: imf.primaries, color_transfer: imf.transfer,
    color_space: "gbr", color_range: "pc", bits_per_raw_sample: String(imf.depth),
    // Chroma siting is inapplicable to RGB. Keep null instead of inventing a YUV tag.
    chroma_location: null, imf: { cplId: imf.cplId, crop: imf.crop, hasDolbyMetadata: imf.hasDolbyMetadata, sourceFormat: imf.sourceFormat },
    audio_streams: audioProbe ? [audioProbe] : [],
    side_data_list: [...existing.filter(item => ![mastering.side_data_type, light.side_data_type].includes(item.side_data_type)), mastering, light] };
}

function buildImfEncode(imf, outputPath) {
  const c = imf.crop, m = imf.mastering;
  // Convert primaries in linear light, then encode PQ YCbCr. Never just relabel P3 as BT.2020.
  const filter = [
    `crop=${c.width}:${c.height}:${c.x}:${c.y}`, "setsar=1", "format=gbrp16le",
    `zscale=matrixin=gbr:primariesin=${imf.primaries}:transferin=smpte2084:rangein=full:matrix=gbr:primaries=${imf.primaries}:transfer=linear:range=full:npl=100`,
    "format=gbrpf32le", "zscale=primaries=bt2020",
    "zscale=transfer=smpte2084:matrix=bt2020nc:range=limited:chromal=left:dither=error_diffusion:npl=100",
    "format=yuv420p10le", "sidedata=mode=delete"
  ].join(",");
  const mastering = `G(${m.green})B(${m.blue})R(${m.red})WP(${m.white})L(${m.max},${m.min})`;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-ss", String(imf.video.start), "-i", imf.video.path,
    ...(imf.audio ? ["-ss", String(imf.audio.start), "-i", imf.audio.path] : []),
    "-map", "0:v:0", ...(imf.audio ? ["-map", "1:a:0"] : []),
    "-t", String(imf.video.seconds), "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", filter, "-c:v", "libx265", "-preset", "medium", "-crf", "18",
    "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-color_primaries", "bt2020",
    "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv",
    "-chroma_sample_location", "left", "-x265-params",
    `pools=2:log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:chromaloc=0:master-display=${mastering}:max-cll=${imf.maxCLL},${imf.maxFALL}:hdr10=1:repeat-headers=1:open-gop=0:scenecut=0`,
    "-force_key_frames", "expr:gte(t,n_forced*4)", "-fps_mode", "passthrough",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath];
  return { args, filter, intent: "imf_rgb_to_hdr10", engine: "zscale/libx265", usesDolbyMetadata: false };
}

function validateImfOutput(imf, probe, contract) {
  const expected = { codecName: "hevc", colorPrimaries: "bt2020", colorTransfer: "smpte2084",
    matrixCoefficients: "bt2020nc", colorRange: "limited", pixelFormat: "yuv420p10le",
    bitDepth: 10, chromaLocation: "left", width: imf.crop.width, height: imf.crop.height };
  const errors = Object.entries(expected).flatMap(([key, val]) => contract[key] === val ? [] : [`IMF output: unexpected ${key}.`]);
  if (Math.abs(Number(probe.duration) - imf.video.seconds) > 1 / imf.frameRate + 0.01 || !Number.isFinite(Number(probe.duration))) errors.push("IMF output: duration differs from CPL.");
  if (Math.abs(probeRate(probe) - imf.frameRate) > 1e-7) errors.push("IMF output: frame rate differs from CPL.");
  if (probe.sample_aspect_ratio !== "1:1") errors.push("IMF output: expected square pixels.");
  if (imf.audio && (!probe.audio_streams?.length || probe.audio_streams.some(s => s.codec_name !== "aac"))) errors.push("IMF output: AAC audio is missing.");
  if (imf.audio && probe.audio_streams?.some(s => !Number.isFinite(Number(s.duration)) ||
      Math.abs(Number(s.duration) - imf.audio.seconds) > 1 / imf.frameRate + 0.05 ||
      (imf.audio.channels && s.channels !== imf.audio.channels))) errors.push("IMF output: audio duration/channel count differs from CPL.");
  if (contract.dolbyMetadata?.profile || contract.dolbyMetadata?.rpuPresent) errors.push("IMF output must not claim Dolby Vision.");
  return errors;
}

function descendants(node, name) {
  return (node?.children || []).flatMap(child => [...(child.name === name ? [child] : []), ...descendants(child, name)]);
}
function optionalText(node, name) {
  const values = children(node, name);
  return values.length === 1 ? values[0].text.trim() : null;
}
function optionalNumber(node, name) {
  const text = optionalText(node, name);
  return text !== null && /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}
function knownColor(node, name, kind) {
  try { return colorUl(optionalText(node, name) || "", kind); } catch { return null; }
}
const sharedValue = values => values.length && values.every(value => value === values[0]) ? values[0] : null;
const dolbyNamespace = text => /^https?:\/\/www\.dolby\.com\/schemas\/dvmd-fw\//.test(text || "");

async function isDolbySidecar(filePath, header) {
  if (dolbyNamespace(header?.namespace)) return true;
  // Resolve CM4 uses dvmd/...; legacy CM2.9 has no default namespace. Require
  // an MDF root, a version and Outputs/Output/Video structure rather than a name
  // on disk. This recognizes an unlinked declaration, not a validated payload.
  if (header?.name !== "DolbyLabsMDF" || (header.namespace &&
      !/^https?:\/\/www\.dolby\.com\/schemas\/dvmd\/\d+(?:_\d+)+$/.test(header.namespace))) return false;
  const file = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const parser = new SaxesParser({ xmlns: true });
    const stack = [];
    let version = "", attributeVersion = false, hasVideo = false, recognized = false, nodes = 0;
    const stop = new Error("bounded MDF inspection finished");
    const recognize = () => {
      if (hasVideo && /^\d+\.\d+\.\d+$/.test(version.trim())) { recognized = true; throw stop; }
    };
    parser.on("doctype", () => { throw stop; });
    parser.on("error", () => { throw stop; });
    parser.on("opentag", tag => {
      if (++nodes > 4096 || stack.length >= 32) throw stop;
      stack.push(tag.local);
      if (stack.length === 1) {
        version = tag.attributes.version?.value || "";
        attributeVersion = Boolean(version);
      }
      if (tag.uri === header.namespace && stack.join("/") === "DolbyLabsMDF/Outputs/Output/Video") hasVideo = true;
      recognize();
    });
    parser.on("text", text => {
      if (!attributeVersion && stack.join("/") === "DolbyLabsMDF/Version") version += text;
    });
    parser.on("closetag", () => { stack.pop(); recognize(); });
    try { parser.write(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch (error) { if (error !== stop) throw error; }
    return recognized;
  } finally { await file.close(); }
}

async function hasPhdrHeader(filePath) {
  // RDD 56 PHDRMetadataTrackSubDescriptor, read only at MXF KLV boundaries.
  // Bounded header inspection is evidence of a declaration, not per-frame validation.
  // https://pub.smpte.org/latest/rdd56/rdd56-2021.pdf
  const file = await fs.open(filePath, "r");
  try {
    const { size } = await file.stat();
    const bytes = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    let offset = 0;
    while (offset + 17 <= bytesRead) {
      const key = Buffer.from(bytes.subarray(offset, offset + 16));
      if (key.readUInt32BE(0) !== 0x060e2b34) return false;
      key[5] = 0x7f; // Normalize MXF local-set coding designator to the registry group UL.
      if (key.toString("hex") === "060e2b34027f01050e09060701010103") return true;
      const first = bytes[offset + 16];
      let length = first, lengthBytes = 1;
      if (first >= 0x80) {
        const count = first & 0x7f;
        if (!count || count > 6 || offset + 17 + count > bytesRead) return false;
        length = bytes.readUIntBE(offset + 17, count);
        lengthBytes += count;
      }
      offset += 16 + lengthBytes + length;
    }
    return false;
  } finally { await file.close(); }
}

async function identifyImfPackage(files) {
  const cpls = [], maps = [], sidecars = [];
  const uploaded = new Map();
  let metadataBytes = 0;
  for (const file of files) {
    const original = imfPackageRelativePath(file.filename);
    if (uploaded.has(original)) fail("Duplicate uploaded package path.");
    uploaded.set(original, file.packagePath);
    if (!/\.xml$|(?:^|\/)ASSETMAP$/i.test(original)) continue;
    const header = await xmlRootInfo(file.packagePath);
    if (await isDolbySidecar(file.packagePath, header)) sidecars.push("xml");
    if (!["CompositionPlaylist", "AssetMap"].includes(header?.name)) continue;
    const size = (await fs.stat(file.packagePath)).size;
    metadataBytes += size;
    if (size > 2 * 1024 * 1024 || metadataBytes > 16 * 1024 * 1024) fail("CPL/ASSETMAP exceeds the XML scan limits (2 MiB per file, 16 MiB total).");
    const root = parseXml(await fs.readFile(file.packagePath, "utf8"));
    (root.name === "CompositionPlaylist" ? cpls : maps).push({ root, original });
  }
  if (!cpls.length && !maps.length) return null;
  const assets = new Map();
  for (const map of maps) for (const asset of descendants(map.root, "Asset")) {
    const chunks = descendants(asset, "Chunk");
    const uri = chunks.length === 1 ? optionalText(chunks[0], "Path") : null;
    const id = optionalText(asset, "Id")?.toLowerCase();
    if (id && uri) assets.set(id, uploaded.get(path.posix.join(path.posix.dirname(map.original), relativePath(uri))) || null);
  }
  const images = [], imagePaths = new Set(), storage = new Set(sidecars), applications = new Set();
  let missingResources = 0, resourceCount = 0, segmentCount = 0;
  for (const { root: cpl } of cpls) {
    for (const item of descendants(cpl, "ApplicationIdentification")) {
      for (const uri of item.text.trim().split(/\s+/)) if (uri && applications.size < 8) applications.add(uri.slice(0, 240));
    }
    segmentCount += descendants(cpl, "Segment").length;
    const descriptors = new Map(descendants(cpl, "EssenceDescriptor").map(node => [optionalText(node, "Id")?.toLowerCase(), node]));
    for (const resource of descendants(cpl, "Resource")) {
      const trackId = optionalText(resource, "TrackFileId")?.toLowerCase();
      if (trackId) { resourceCount++; if (!assets.get(trackId)) missingResources++; }
    }
    for (const sequence of descendants(cpl, "MainImageSequence")) for (const resource of descendants(sequence, "Resource")) {
      const descriptor = descriptors.get(optionalText(resource, "SourceEncoding")?.toLowerCase());
      const rgb = children(descriptor, "RGBADescriptor")[0], yuv = children(descriptor, "CDCIDescriptor")[0];
      const image = rgb || yuv;
      const file = assets.get(optionalText(resource, "TrackFileId")?.toLowerCase());
      if (file) imagePaths.add(file);
      if (descendants(descriptor, "PHDRMetadataTrackSubDescriptor").length || descendants(descriptor, "PHDRMetaDataTrackSubDescriptor").length) storage.add("phdr");
      const depths = rgb ? descendants(rgb, "RGBAComponent").filter(node => ["CompRed", "CompGreen", "CompBlue"].includes(optionalText(node, "Code"))).map(node => optionalNumber(node, "ComponentSize")) : [];
      const depth = rgb ? sharedValue(depths) : optionalNumber(yuv, "ComponentDepth");
      const min = optionalNumber(image, rgb ? "ComponentMinRef" : "BlackRefLevel");
      const max = optionalNumber(image, rgb ? "ComponentMaxRef" : "WhiteRefLevel");
      const range = depth && min !== null && max !== null
        ? min === 0 && max === 2 ** depth - 1 ? "full"
          : min === 16 * 2 ** (depth - 8) && max === 235 * 2 ** (depth - 8) ? "limited" : "custom"
        : "unknown";
      const compression = (optionalText(image, "PictureCompression") || "").replace(/^urn:smpte:ul:/i, "").replaceAll(".", "");
      images.push({ colorModel: rgb ? "rgb" : yuv ? "ycbcr" : "unknown", bitDepth: depth,
        codec: /^060e2b34040101[\da-f]{2}04010202030101[\da-f]{2}$/i.test(compression) ? "jpeg2000" : null,
        primaries: knownColor(image, "ColorPrimaries", "primaries"), transfer: knownColor(image, "TransferCharacteristic", "transfer"), range });
    }
    for (const sequence of descendants(cpl, "ISXDSequence")) for (const resource of descendants(sequence, "Resource")) {
      const descriptor = descriptors.get(optionalText(resource, "SourceEncoding")?.toLowerCase());
      if (descendants(descriptor, "NamespaceURI").some(node => dolbyNamespace(node.text.trim()))) storage.add("isxd");
    }
  }
  // Limit binary inspection for multi-composition packages. A negative bounded
  // scan is deliberately never interpreted as proof that Dolby metadata is absent.
  for (const file of [...imagePaths].slice(0, 4)) if (await hasPhdrHeader(file)) storage.add("phdr");
  const transfer = sharedValue(images.map(image => image.transfer));
  return {
    version: 1, container: "imf", applicationIds: [...applications],
    colorModel: sharedValue(images.map(image => image.colorModel)) || (images.length ? "mixed" : "unknown"),
    codec: sharedValue(images.map(image => image.codec)), bitDepth: sharedValue(images.map(image => image.bitDepth)),
    primaries: sharedValue(images.map(image => image.primaries)), transfer,
    range: sharedValue(images.map(image => image.range)) || "unknown",
    dynamicRange: transfer === "smpte2084" ? "pq" : transfer === "arib-std-b67" ? "hlg"
      : ["bt709", "gamma22", "smpte240m", "bt2020-10"].includes(transfer) ? "sdr" : "unknown",
    compositionCount: cpls.length, segmentCount,
    packageKind: missingResources ? "external_references" : resourceCount ? "self_contained" : "unknown",
    missingResources,
    dolbyVision: { status: storage.has("isxd") ? "declared" : storage.has("phdr") ? "candidate" : storage.has("xml") ? "unlinked" : "unknown",
      storage: [...storage], validation: "not_validated" },
    // Application identifiers describe a format family, not a vendor preset or compliance certificate.
    preset: null
  };
}

async function inspectImfPackage(files) {
  const sourceFormat = await identifyImfPackage(files);
  try {
    const imf = await inspectRgbImfPackage(files);
    if (!imf) return null;
    return { ...imf, sourceFormat, hasDolbyMetadata: imf.hasDolbyMetadata || sourceFormat?.dolbyVision.status === "declared" };
  } catch (error) {
    if (sourceFormat) error.sourceFormat = sourceFormat;
    throw error;
  }
}

// Preserve original Unicode filenames inside an IMF archive so CPL/ASSETMAP
// references still work when the retained package is opened in another tool.
const imfPackageRelativePath = filename => relativePath(String(filename).replace(/\\/g, "/"), false);
module.exports = { parseXml, identifyImfPackage, inspectImfPackage, imfPackageRelativePath, hashImfPackage, applyImfColor, buildImfEncode, validateImfOutput };
