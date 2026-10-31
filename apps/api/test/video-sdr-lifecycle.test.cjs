const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const crypto = require("node:crypto");
const sdr = require("../src/video-sdr.cjs");
const hls = require("../src/hls-metadata.cjs");
const integrity = require("../src/video-integrity.cjs");
const { createTaskLimiter } = require("../src/task-limiter.cjs");
// Allow the same explicit executable overrides as the API for custom FFmpeg builds.
const ffmpeg = process.env.FFMPEG_PATH || require("ffmpeg-static");
const ffprobe = process.env.FFPROBE_PATH || require("ffprobe-static").path;

function mapNeutralSamples(transfer, signals, hdrStaticMetadata = {}) {
  // Feed real 10-bit YUV through the production filter; inspect pixels before
  // lossy encoding so color tags or successful encoding cannot hide bad mapping.
  const width = 16 * signals.length;
  const height = 16;
  const pixels = width * height;
  const input = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels * 3 / 2; i++) {
    const signal = signals[Math.floor((i % width) / 16)];
    input.writeUInt16LE(i < pixels ? Math.round(64 + 876 * signal) : 512, i * 2);
  }
  const conversion = sdr.buildDolbySdrConversion({
    colorTransfer: transfer, colorPrimaries: "bt2020", matrixCoefficients: "bt2020nc",
    colorRange: "limited", dolbyMetadata: {},
    hdrStaticMetadata
  }, new Set(["libplacebo"]));
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "yuv420p10le",
    "-video_size", `${width}x${height}`, ...conversion.inputOptions, "-color_primaries", "bt2020", "-color_trc", transfer,
    "-colorspace", "bt2020nc", "-color_range", "tv", "-i", "pipe:0",
    "-vf", conversion.filter, "-frames:v", "1", "-f", "rawvideo", "pipe:1"
  ], { input, timeout: 30000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, pixels * 3 / 2);
  const chroma = [...result.stdout.subarray(pixels)];
  assert.ok(chroma.every(value => Math.abs(value - 128) <= 1), "Neutral input must remain neutral");
  return signals.map((_, patch) => {
    const y = [];
    for (let row = 0; row < height; row++) for (let x = 2; x < 14; x++) y.push(result.stdout[row * width + patch * 16 + x]);
    assert.ok(y.every(value => value >= 16 && value <= 235), `Out-of-range luma: ${Math.min(...y)}..${Math.max(...y)}`);
    return y.reduce((sum, value) => sum + value, 0) / y.length;
  });
}

test("HLG neutral highlights remain neutral and map to SDR reference white", () => {
  const samples = mapNeutralSamples("arib-std-b67", [0, 0.5, 0.75, 1]);
  assert.ok(Math.abs(samples[0] - 16) <= 1);
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i] > samples[i - 1] + 1, `${samples}`);
});

test("PQ high highlights stay distinguishable without MaxCLL, including mastering and unknown peaks", () => {
  // ST 2084 OETF converts known luminance patches into encoded PQ samples.
  const pq = nits => {
    const linear = (nits / 10000) ** (2610 / 16384);
    return ((3424 / 4096 + 2413 / 128 * linear) / (1 + 2392 / 128 * linear)) ** (2523 / 32);
  };
  for (const metadata of [
    { contentLightLevel: { max_content: 4000 } },
    { masteringDisplay: { max_luminance: "40000000/10000" } },
    {}
  ]) {
    const nits = metadata.contentLightLevel || metadata.masteringDisplay
      ? [0, 1000, 2000, 4000] : [0, 1000, 2000, 4000, 10000];
    const samples = mapNeutralSamples("smpte2084", nits.map(pq), metadata);
    assert.ok(Math.abs(samples[0] - 16) <= 1);
    assert.ok(samples.at(-1) > 200);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i] > samples[i - 1] + 1, `Highlights collapsed: ${samples}`);
    }
  }
});

test("adaptive peak analysis responds to content and perceptual mapping avoids saturated channel clipping", () => {
  const pq = nits => {
    const p = (nits / 10000) ** (2610 / 16384);
    return ((3424 / 4096 + 2413 / 128 * p) / (1 + 2392 / 128 * p)) ** (2523 / 32);
  };
  function render(peak, adaptive, gamut = "perceptual", red = false) {
    const width = 32, height = 16, frames = 36;
    const frame = Buffer.alloc(width * height * 3 * 4);
    // A stable 100-nit patch next to a changing peak tests content adaptation, not tags.
    for (let plane = 0; plane < 3; plane++) for (let i = 0; i < width * height; i++) {
      const nits = i % width < 16 ? red ? (plane === 2 ? 100 : 0) : 100 : peak;
      frame.writeFloatLE(pq(nits), (plane * width * height + i) * 4);
    }
    const conversion = sdr.buildDolbySdrConversion({ colorTransfer: "smpte2084", dolbyMetadata: {} }, new Set(["libplacebo"]));
    const filter = conversion.filter.replace("peak_detect=true", `peak_detect=${adaptive}`)
      .replace("gamut_mode=perceptual", `gamut_mode=${gamut}`);
    const result = spawnSync(ffmpeg, ["-v", "error", ...conversion.inputOptions, "-f", "rawvideo",
      "-pixel_format", "gbrpf32le", "-video_size", "32x16", "-framerate", "24", "-color_primaries", "bt2020",
      "-color_trc", "smpte2084", "-colorspace", "rgb", "-color_range", "pc", "-i", "pipe:0",
      "-vf", filter, "-frames:v", String(frames), "-f", "rawvideo", "pipe:1"],
    { input: Buffer.concat(Array(frames).fill(frame)), timeout: 30000 });
    assert.equal(result.status, 0, result.stderr?.toString());
    const last = result.stdout.subarray((frames - 1) * width * height * 1.5);
    return [last[8], last[width * height + 4], last[width * height * 1.25 + 4]];
  }
  assert.ok(Math.abs(render(1000, false)[0] - render(4000, false)[0]) <= 2);
  assert.ok(render(1000, true)[0] > render(4000, true)[0] + 5, "Peak detection must change the mapping with content");
  const clipped = render(1000, true, "clip", true);
  const compressed = render(1000, true, "perceptual", true);
  assert.ok(compressed[2] < clipped[2] - 5, "Out-of-gamut red should be compressed before quantization");
  assert.ok(compressed[0] >= 16 && compressed[0] <= 235);
});

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "video-sdr-"));
  assert.equal(path.dirname(root), os.tmpdir());
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await fsp.readFile(path.join(__dirname, "../src/server.cjs"), "utf8");
  const names = [
    "httpError", "runProcess", "withLocalHlsInput", "probeMediaStreams", "probeVideo", "prepareOutputDir", "assertInside", "safePathSegment",
    "availableVideoSdrFilters", "quarantineStaleSdrMasters", "createDolbySdrMaster", "generateHls", "isHevcCodec",
    "buildColorContract", "normalizePrimaries", "normalizeTransfer", "normalizeMatrix", "normalizeRange",
    "normalizeColorToken", "extractHdrStaticMetadata", "extractDolbyVisionMetadata", "firstDefined",
    "stringOrNull", "booleanOrFalse", "inferBitDepth", "defaultBitDepth", "expectedVideoRange",
    "normalizeHlsVideoRange", "normalizeDolbyProfileVersion", "normalizeNumberLabel", "parseInteger", "validateColorContract", "validateHdrGamut",
    "compareColorContracts", "validateDolbyContract", "validateDolbyVisionUpload", "throwColorContractError", "finalizeHlsOutput", "writeMultivariantPlaylist",
    "serializeHlsAttributeList", "stampHlsPlaylist", "writeVerificationReport", "inspectHlsMediaFiles",
    "localHlsPath", "stripUriQuery", "parseHlsAttributeList", "prepareHlsPackageOutput", "copiedHlsVariants",
    "copiedHlsMasterTags", "rebaseHlsUri", "primaryMediaPlaylistPath", "parseVariantUris", "parseStreamInfoVariants",
    "summarizeProbe", "createOrUpdateDirectusRecords", "findMastersByIdentity", "clearDefaultMasters",
    "sha256File", "mediaUrlFromPath", "prettyCodec", "prettyColorSpace", "prettyTransferFunction",
    "defaultCodec", "defaultColorSpace", "defaultTransferFunction", "defaultLabel", "handleUpload", "handleUploadNow",
    "resolveVideoUploadProject", "handleVideoUploadProjects", "identifyPairedSources", "inspectCompanionSdr", "saveCompanionSdr", "moveSourceFile",
    "normalizeUpload", "parseTags", "parseBoolean", "parseNullableInteger", "parseDecimal", "validateSlug"
  ];
  const declarations = names.map(name => {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  const masters = [{ id: 10, type: "dolby_vision", project_id: 7, is_default: true }];
  let nextId = 11;
  const context = vm.createContext({
    ...require("../../../shared/video-source-format.cjs"),
    ...sdr, ...hls, ...integrity, moveUploadFile: require("../src/resource-io.cjs").moveUploadFile, fs, fsp, path, spawn, setTimeout, clearTimeout, crypto, URLSearchParams,
    ROOT: root, REPO_ROOT: root, MEDIA_ROOT: root, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe,
    VIDEO_SDR_PROCESS_TIMEOUT_MS: 30000,
    // Exercise the same upload admission path without changing the media fixtures.
    VIDEO_PROCESS_TIMEOUT_MS: 30000,
    videoProcessingSlots: createTaskLimiter(),
    legacyUploadSlots: { acquire: async () => () => {} },
    videoUploads: { reserveLegacy: async () => () => {} }, MAX_LEGACY_UPLOAD_BYTES: 20 * 1024 * 1024,
    resourceLimits: require("../../../config/resource-profile.cjs").resolveResourceProfile({}),
    mediaContext: new (require("node:async_hooks").AsyncLocalStorage)(),
    mediaThreadArgs: require("../src/resource-io.cjs").mediaThreadArgs, Buffer,
    HDR_MASTER_TYPES: new Set(["hdr10", "hlg", "dolby_vision"]),
    MASTER_TYPES: new Set(["sdr", "hdr10", "hlg", "dolby_vision", "custom"]),
    SOURCE_KINDS: new Set(["embedded", "master_package", "hls_package"]),
    TRANSCODE_TYPES: new Set(["sdr", "custom"]),
    COLOR_REQUIRED_FIELDS: ["colorPrimaries", "colorTransfer", "matrixCoefficients", "colorRange", "pixelFormat", "bitDepth", "chromaLocation"],
    directusLogin: async () => "fixture-token",
    directusUploadFile: async () => null,
    findProjectBySlug: async () => { throw new Error("Derivative must reuse the existing project"); },
    directusRequest: async (url, token, options) => {
      const parsed = new URL(url, "http://fixture.invalid");
      if (!options) {
        let result = masters.filter(master => master.project_id === Number(parsed.searchParams.get("filter[project_id][_eq]")));
        for (const [key, value] of parsed.searchParams) {
          const field = key.match(/^filter\[([^\]]+)\]\[_eq\]$/)?.[1];
          if (field) result = result.filter(master => String(master[field]) === value);
        }
        return { data: result.map(master => ({ ...master })) };
      }
      if (options.method === "POST") {
        const master = { id: nextId++, ...options.body };
        masters.push(master);
        return { data: { ...master } };
      }
      const id = Number(parsed.pathname.split("/").at(-1));
      const index = masters.findIndex(master => master.id === id);
      assert.ok(index >= 0, `Unknown master ${id}`);
      if (options.method === "DELETE") masters.splice(index, 1);
      else Object.assign(masters[index], options.body);
      return { data: { ...masters[index] } };
    }
  });
  vm.runInContext("let videoSdrFiltersPromise = null;\n" + declarations, context);
  return { api: context, root, masters };
}

test("filter discovery recognizes both legacy and multi-input libplacebo listings", async t => {
  for (const signature of ["V->V", "N->V"]) {
    const { api } = await fixture(t);
    let calls = 0;
    // Match the Windows full-build listing, including unrelated tonemap backends.
    api.runProcess = async () => {
      calls += 1;
      return { stdout: [
        ` .. libplacebo        ${signature}       Apply various GPU filters from libplacebo`,
        " .S tonemap           V->V       Conversion to/from different dynamic ranges.",
        " .. tonemap_opencl    V->V       Perform HDR to SDR conversion with tonemapping.",
        " .. tonemap_vaapi     V->V       VAAPI VPP for tone-mapping",
        " .S zscale            V->V       Apply resizing, colorspace and bit depth conversion."
      ].join("\n") };
    };
    const filters = await api.availableVideoSdrFilters();
    assert.deepEqual([...filters].sort(), ["libplacebo", "tonemap", "zscale"]);
    assert.equal(await api.availableVideoSdrFilters(), filters);
    assert.equal(calls, 1);
    const conversion = sdr.buildDolbySdrConversion({
      colorTransfer: "smpte2084", dolbyMetadata: { profile: "5", rpuPresent: true }
    }, filters);
    assert.equal(conversion.engine, "libplacebo");
  }
});

async function makeHlgFixture(api, root, withAudio = true) {
  const sourcePath = path.join(root, "source-hlg.mp4");
  await execFile(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24",
    ...(withAudio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []), "-t", "0.5",
    // Set HEVC VUI explicitly: some libx265 builds do not inherit container color tags.
    "-c:v", "libx265", "-preset", "ultrafast", "-x265-params",
    "log-level=error:pools=1:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
    "-pix_fmt", "yuv420p10le", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67",
    "-colorspace", "bt2020nc", "-color_range", "tv", "-chroma_sample_location", "left",
    ...(withAudio ? ["-c:a", "aac"] : []), sourcePath
  ], { windowsHide: true });
  const probe = await api.probeVideo(sourcePath);
  const metadata = { title: "Fixture", slug: "fixture", label: "HLG", masterType: "hlg", isDefault: true, published: false };
  // Synthetic HLG is not Dolby Vision: a sidecar must never upgrade it to Dolby.
  const contract = api.buildColorContract(probe, metadata);
  const hash = crypto.createHash("sha256").update(await fsp.readFile(sourcePath)).digest("hex");
  const records = { project: { id: 7 }, master: { id: 10, source_sha256: hash } };
  return { sourcePath, probe, metadata, contract, hash, records };
}

test("real HLG encoding produces a verified independent SDR master, retains Dolby, and upserts only its paired derivative", async t => {
  const { api, root, masters } = await fixture(t);
  const input = await makeHlgFixture(api, root);
  const manual = { id: 99, project_id: 7, type: "sdr", label: "SDR (Dolby Vision)", is_default: false, hls_url: "/manual.m3u8" };
  masters.push(manual);
  const result = await api.createDolbySdrMaster(input.metadata, input.sourcePath, input.probe, input.contract, input.records);
  assert.equal(result.status, "ready");
  assert.equal(result.master.type, "sdr");
  assert.equal(result.master.derived_from_master_id, 10);
  assert.equal(result.master.source_sha256, input.hash);
  assert.equal(result.master.verification_status, "ready");
  assert.equal(result.master.is_default, true);
  assert.equal(result.master.dolby_profile, null);
  assert.match(result.master.file_url, /sdr\.mp4$/);
  assert.equal(masters.find(master => master.id === 10).is_default, false);
  assert.equal(masters.filter(master => master.is_default).length, 1);
  assert.deepEqual(manual, { id: 99, project_id: 7, type: "sdr", label: "SDR (Dolby Vision)", is_default: false, hls_url: "/manual.m3u8" });
  const playlist = await fsp.readFile(path.join(root, result.hlsUrl.replace("/media/", "")), "utf8");
  assert.match(playlist, /VIDEO-RANGE=SDR/);
  assert.match(playlist, /CODECS="avc1\./);
  assert.match(playlist, /,mp4a\.40\.2/);
  assert.equal(result.colorContract.colorPrimaries, "bt709");
  assert.equal(result.colorContract.colorTransfer, "bt709");
  assert.equal(result.colorContract.bitDepth, 8);
  const outputPath = path.join(root, result.fileUrl.replace("/media/", ""));
  const outputInfo = JSON.parse((await execFile(ffprobe, ["-v", "error", "-show_streams", "-of", "json", outputPath], { windowsHide: true })).stdout);
  assert.ok(outputInfo.streams.some(stream => stream.codec_name === "aac"));
  assert.ok(Math.abs(Number(outputInfo.streams.find(stream => stream.codec_type === "video").duration) - 0.5) < 0.1);
  const before = await execFile(ffmpeg, ["-v", "error", "-i", input.sourcePath, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", windowsHide: true });
  const after = await execFile(ffmpeg, ["-v", "error", "-i", outputPath, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", windowsHide: true });
  const meanDifference = before.stdout.reduce((total, value, index) => total + Math.abs(value - after.stdout[index]), 0) / before.stdout.length;
  assert.ok(meanDifference > 5, `Pixel values must be mapped, not merely retagged: ${meanDifference}`);
  const second = await api.createDolbySdrMaster({ ...input.metadata, label: "Renamed Dolby" }, input.sourcePath, input.probe, input.contract, input.records);
  assert.equal(second.master.id, result.master.id);
  assert.equal(masters.filter(master => master.derived_from_master_id === 10).length, 1);
  assert.equal(masters.find(master => master.id === 99).hls_url, "/manual.m3u8");
  assert.equal(crypto.createHash("sha256").update(await fsp.readFile(input.sourcePath)).digest("hex"), input.hash);
});

test("video-only Dolby input generates SDR HLS without an invented audio codec", async t => {
  const { api, root } = await fixture(t);
  const input = await makeHlgFixture(api, root, false);
  assert.equal(input.probe.audio_streams.length, 0);
  const result = await api.createDolbySdrMaster(input.metadata, input.sourcePath, input.probe, input.contract, input.records);
  const playlist = await fsp.readFile(path.join(root, result.hlsUrl.replace("/media/", "")), "utf8");
  assert.match(playlist, /CODECS="avc1\.64000A"/);
  assert.doesNotMatch(playlist, /mp4a/);
});

test("failed SDR verification never registers a master and removes only its incomplete output", async t => {
  const { api, root, masters } = await fixture(t);
  const input = await makeHlgFixture(api, root);
  masters.push({
    id: 11, project_id: 7, type: "sdr", is_derivative: true, derived_from_master_id: 10,
    conversion_intent: "hdr_to_sdr", source_sha256: "previous-source",
    verification_status: "ready", is_default: true
  });
  api.probeVideo = async () => ({ ...input.probe, codec_name: "h264" });
  await assert.rejects(api.createDolbySdrMaster(input.metadata, input.sourcePath, input.probe, input.contract, input.records), /verification failed/);
  assert.equal(masters.length, 2);
  assert.equal(masters[1].verification_status, "quarantine");
  assert.equal(masters[1].is_default, false);
  await fsp.access(input.sourcePath);
  assert.deepEqual(await fsp.readdir(path.join(root, "fixture", "sdr")), []);
});

test("HLS package input produces SDR and preserves an existing default unless none exists", async t => {
  const { api, root, masters } = await fixture(t);
  const input = await makeHlgFixture(api, root);
  const sourceDir = path.join(root, "hls-package");
  await fsp.mkdir(sourceDir);
  const hls = await api.generateHls(input.sourcePath, sourceDir, { ...input.metadata, mode: "copy" }, input.probe);
  await api.stampHlsPlaylist(hls.mediaPlaylistPath);
  const playlistBefore = await fsp.readFile(hls.mediaPlaylistPath, "utf8");
  masters[0].is_default = false;
  masters.push({ id: 99, project_id: 7, type: "sdr", is_default: true });
  const result = await api.createDolbySdrMaster({ ...input.metadata, isDefault: false }, hls.mediaPlaylistPath, input.probe, input.contract, input.records);
  assert.equal(result.master.is_default, false);
  assert.equal(masters.find(master => master.id === 99).is_default, true);
  assert.equal(await fsp.readFile(hls.mediaPlaylistPath, "utf8"), playlistBefore);
  masters.find(master => master.id === 99).is_default = false;
  const second = await api.createDolbySdrMaster({ ...input.metadata, isDefault: false }, hls.mediaPlaylistPath, input.probe, input.contract, input.records);
  assert.equal(second.master.is_default, true);
  assert.equal(masters.filter(master => master.is_default).length, 1);
  assert.ok(!(await fsp.readdir(sourceDir)).some(name => name.startsWith(".hls-read-")));
});

test("copied HLS retains external audio groups, fixes variant declarations and rejects missing media", async t => {
  const { api, root } = await fixture(t);
  const input = await makeHlgFixture(api, root, false);
  const sourceDir = path.join(root, "package");
  const malformed = api.parseStreamInfoVariants("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-STREAM-INF:BANDWIDTH=2\nvideo.m3u8\n");
  assert.equal(malformed[0].uri, null);
  assert.equal(malformed[1].uri, "video.m3u8");
  for (const folder of ["video", "audio", "nested"]) await fsp.mkdir(path.join(sourceDir, folder), { recursive: true });
  const video = await api.generateHls(input.sourcePath, path.join(sourceDir, "video"), { ...input.metadata, mode: "copy" }, input.probe);
  await execFile(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "0.5",
    "-c:a", "aac", "-f", "hls", "-hls_segment_type", "fmp4", "-hls_playlist_type", "vod",
    path.join(sourceDir, "audio", "media.m3u8")
  ], { windowsHide: true, cwd: path.join(sourceDir, "audio") });
  const sourceMaster = path.join(sourceDir, "nested", "master.m3u8");
  await fsp.writeFile(sourceMaster, [
    "#EXTM3U", "#EXT-X-VERSION:7",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="Main audio",DEFAULT=YES,AUTOSELECT=YES,URI="../audio/media.m3u8?origin=fixture"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x480,FRAME-RATE=10,CODECS="hvc1.1.6.L93.B0",SUPPLEMENTAL-CODECS="dvh1.05.03",VIDEO-RANGE=HLG,AUDIO="stereo"',
    "../video/media.m3u8?origin=fixture", ""
  ].join("\n"));
  const outputDir = path.join(root, "copied");
  const output = await api.prepareHlsPackageOutput({ packageDir: sourceDir, sourcePath: sourceMaster }, outputDir);
  const outputProbe = await api.probeVideo(output.mediaPlaylistPath);
  const inspected = await api.writeMultivariantPlaylist(
    output.masterPlaylistPath, output.mediaPlaylistPath, input.contract, outputProbe, output.variants, output.masterTags
  );
  const playlist = await fsp.readFile(output.masterPlaylistPath, "utf8");
  assert.match(playlist, /#EXT-X-MEDIA:.*URI="audio\/media.m3u8\?origin=fixture"/);
  assert.match(playlist, /AUDIO="stereo"/);
  assert.match(playlist, /video\/media.m3u8\?origin=fixture/);
  assert.match(playlist, /RESOLUTION=160x90/);
  assert.match(playlist, /FRAME-RATE=24.000/);
  assert.match(playlist, /CODECS="hvc1\.2\.4\.L30\.90,mp4a\.40\.2"/);
  assert.doesNotMatch(playlist, /SUPPLEMENTAL-CODECS|INDEPENDENT-SEGMENTS/);
  assert.equal(inspected.length, 1);
  const sdr = await api.createDolbySdrMaster(input.metadata, sourceMaster, input.probe, input.contract, input.records);
  const sdrProbe = await api.probeVideo(path.join(root, sdr.fileUrl.replace("/media/", "")));
  assert.equal(sdrProbe.audio_streams[0]?.codec_name, "aac");
  assert.ok(!(await fsp.readdir(path.dirname(sourceMaster))).some(name => name.startsWith(".hls-read-")));
  await assert.rejects(api.writeMultivariantPlaylist(
    output.masterPlaylistPath, output.mediaPlaylistPath, input.contract, input.probe,
    output.variants, ["#EXTM3U"]
  ), /AUDIO group is missing/);
  const mediaText = await fsp.readFile(video.mediaPlaylistPath, "utf8");
  const segment = mediaText.split(/\r?\n/).find(line => line.endsWith(".m4s"));
  const segmentPath = path.resolve(path.dirname(video.mediaPlaylistPath), segment);
  assert.equal(path.dirname(segmentPath), path.dirname(video.mediaPlaylistPath));
  await fsp.unlink(segmentPath);
  await assert.rejects(api.inspectHlsMediaFiles(video.mediaPlaylistPath, sourceDir), /missing or empty/);
});

test("an uncertain CMS write preserves verified SDR files for recovery", async t => {
  const { api, root, masters } = await fixture(t);
  const input = await makeHlgFixture(api, root);
  const request = api.directusRequest;
  let committed;
  api.directusRequest = async (url, token, options) => {
    const result = await request(url, token, options);
    if (options?.method === "POST") {
      committed = result.data;
      throw new Error("CMS response lost after commit");
    }
    return result;
  };
  await assert.rejects(api.createDolbySdrMaster(input.metadata, input.sourcePath, input.probe, input.contract, input.records), /response lost/);
  assert.equal(masters.length, 2);
  await fsp.access(path.join(root, committed.hls_url.replace("/media/", "")));
  await fsp.access(path.join(root, committed.file_url.replace("/media/", "")));
  await fsp.access(input.sourcePath);
});

test("upload reports SDR failure while retaining the successfully saved Dolby master", async t => {
  const { api } = await fixture(t);
  let response;
  let saved = false;
  api.requireUploadAuth = () => {};
  api.parseMultipart = async () => ({ fields: {}, files: {}, file: {} });
  api.normalizeUpload = () => ({ masterType: "dolby_vision" });
  api.resolveVideoUploadProject = async () => ({ metadata: api.normalizeUpload(), project: null });
  api.validateProcessingPolicy = () => {};
  api.moveSourceFile = async () => "original.mp4";
  api.parseDolbyProfileFiles = async () => ({});
  api.probeVideo = async () => ({});
  api.validateDolbyVisionUpload = () => {};
  api.buildColorContract = () => ({});
  api.validateColorContract = () => [];
  api.prepareOutputDir = async () => "output";
  api.generateHls = async () => ({});
  api.finalizeHlsOutput = async () => ({ playlistPath: "master.m3u8" });
  api.createOrUpdateDirectusRecords = async () => {
    saved = true;
    return { project: { id: 7 }, master: { id: 10, type: "dolby_vision" } };
  };
  api.createDolbySdrMaster = async () => { assert.equal(saved, true); throw new Error("tone mapping failed"); };
  api.mediaUrlFromPath = value => value;
  api.sendJson = (res, code, body) => { response = { code, body }; };
  await api.handleUpload({ headers: {} }, {});
  assert.equal(response.code, 201);
  assert.equal(response.body.master.type, "dolby_vision");
  assert.equal(response.body.sdrDerivative.status, "failed");
  assert.equal(response.body.masters.length, 1);
});

test("append resolves stable project identity and ignores stale project metadata", async t => {
  const { api } = await fixture(t);
  const project = { id: 7, title: "Original", slug: "original", description: "Keep me", tags: ["film"], published: true };
  api.directusRequest = async url => { assert.equal(url, "/items/video_projects/7"); return { data: project }; };
  const result = await api.resolveVideoUploadProject({ projectId: "7", title: "Stale", slug: "wrong", published: "false", masterType: "sdr" });
  assert.equal(result.project, project);
  assert.equal(result.metadata.title, "Original");
  assert.equal(result.metadata.slug, "original");
  assert.equal(result.metadata.description, "Keep me");
  assert.equal(result.metadata.published, true);
  assert.equal(result.metadata.isDefault, undefined);
  assert.deepEqual([...result.metadata.tags], ["film"]);
  await assert.rejects(api.resolveVideoUploadProject({ projectId: "7oops" }), /Invalid projectId/);
  api.directusRequest = async () => ({ data: null });
  await assert.rejects(api.resolveVideoUploadProject({ projectId: "7" }), /no longer exists/);
});

test("existing-project registration preserves omitted defaults on overwrite and respects explicit choices", async t => {
  // Cover omission separately from explicit false, and retain non-default behavior on append.
  for (const scenario of [
    { overwrite: true, previous: true, expected: true },
    { overwrite: true, previous: false, expected: false },
    { overwrite: true, previous: true, isDefault: "false", expected: false },
    { overwrite: true, previous: false, isDefault: "true", expected: true },
    { overwrite: false, previous: true, expected: false },
    { overwrite: false, previous: true, isDefault: "true", expected: true }
  ]) {
    const { api, root, masters } = await fixture(t);
    const project = { id: 7, title: "Fixture", slug: "fixture" };
    Object.assign(masters[0], { type: "sdr", label: "SDR", is_default: scenario.previous });
    const request = api.directusRequest;
    api.directusRequest = async (url, ...args) => url === "/items/video_projects/7"
      ? { data: project } : request(url, ...args);
    const { metadata } = await api.resolveVideoUploadProject({
      projectId: "7", masterType: "sdr", label: "SDR",
      overwrite: String(scenario.overwrite), isDefault: scenario.isDefault
    });
    const result = await api.createOrUpdateDirectusRecords(metadata, path.join(root, "source.mp4"), path.join(root, "master.m3u8"), {}, {}, {}, {
      project, sourceHash: "new-source", sourceContract: {}, outputContract: {}
    });
    assert.equal(result.master.is_default, scenario.expected, JSON.stringify(scenario));
    assert.equal(result.master.id === 10, scenario.overwrite);
    const expectedDefaultCount = scenario.overwrite ? Number(scenario.expected) : 1;
    assert.equal(masters.filter(master => master.is_default).length, expectedDefaultCount);
  }
});

test("HDR overwrite quarantines stale automatic SDR even without conversion or with a supplied SDR", async t => {
  for (const masterType of ["hdr10", "hlg", "dolby_vision"]) {
    for (const supplied of [false, true]) {
      const { api, root, masters } = await fixture(t);
      const project = { id: 7, title: "Fixture", slug: "fixture" };
      const metadata = api.normalizeUpload({ ...project, masterType, label: "HDR", overwrite: "true", isDefault: "false" });
      Object.assign(masters[0], { type: masterType, label: "HDR", source_sha256: "old-source", is_default: false });
      const sourcePath = path.join(root, "replacement.mp4");
      await fsp.writeFile(sourcePath, "replacement HDR contents");
      const hash = await api.sha256File(sourcePath);
      const automatic = {
        project_id: 7, type: "sdr", is_derivative: true, derived_from_master_id: 10,
        conversion_intent: masterType === "dolby_vision" ? sdr.AUTO_SDR_CONVERSION : "hdr_to_sdr",
        verification_status: "ready", is_default: false
      };
      masters.push(
        { ...automatic, id: 20, source_sha256: "old-source", is_default: true },
        { ...automatic, id: 21, source_sha256: hash },
        { ...automatic, id: 22, source_sha256: "old-source", is_derivative: false, conversion_intent: null },
        { ...automatic, id: 23, source_sha256: "old-source", derived_from_master_id: 99 }
      );
      // Keep real CMS registration and invalidation; isolate only media processing and HTTP IO.
      api.requireUploadAuth = () => {};
      api.parseMultipart = async () => ({ fields: {}, files: supplied ? { sdrVideo: {} } : {}, file: {} });
      api.resolveVideoUploadProject = async () => ({ metadata, project });
      api.validateProcessingPolicy = () => {};
      api.inspectCompanionSdr = async file => file ? {} : null;
      api.moveSourceFile = async () => sourcePath;
      api.parseDolbyProfileFiles = async () => ({});
      api.probeVideo = async () => ({});
      api.validateDolbyVisionUpload = () => {};
      api.buildColorContract = () => ({});
      api.validateColorContract = () => [];
      api.prepareOutputDir = async () => root;
      api.generateHls = async () => ({});
      api.finalizeHlsOutput = async () => ({ playlistPath: path.join(root, "master.m3u8"), outputContract: {} });
      api.createDolbySdrMaster = async () => assert.fail("Existing projects must not trigger automatic conversion");
      api.saveCompanionSdr = async () => {
        assert.equal(masters.find(master => master.id === 20).verification_status, "quarantine");
        return { status: "ready", master: { id: 24 } };
      };
      let response;
      api.sendJson = (res, code, body) => { response = { code, body }; };
      await api.handleUpload({ headers: {} }, {});
      assert.equal(response.code, 201, response.body.error);
      assert.equal(response.body.sdrDerivative, null);
      assert.equal(response.body.master.source_sha256, hash);
      assert.equal(masters.find(master => master.id === 20).verification_status, "quarantine");
      assert.equal(masters.find(master => master.id === 20).is_default, false);
      for (const id of [21, 22, 23]) {
        assert.equal(masters.find(master => master.id === id).verification_status, "ready");
      }
    }
  }
});

test("paired SDR is verified and registered as a manual master without rewriting project or default", async t => {
  const { api, root, masters } = await fixture(t);
  const input = await makeHlgFixture(api, root, false);
  const sdrPath = path.join(root, "manual-sdr.mp4");
  const conversion = sdr.buildDolbySdrConversion(input.contract, new Set(["libplacebo"]));
  await execFile(ffmpeg, sdr.buildSdrEncodeArgs(input.sourcePath, sdrPath, conversion));
  const companion = await api.inspectCompanionSdr({ tempPath: sdrPath, filename: "source-hlg.mp4" }, input.metadata);
  const saved = await api.saveCompanionSdr(companion, input.records.project);
  assert.equal(saved.status, "ready");
  assert.equal(saved.master.project_id, 7);
  assert.equal(saved.master.type, "sdr");
  assert.equal(saved.master.is_derivative, false);
  assert.equal(saved.master.derived_from_master_id, null);
  assert.equal(saved.master.conversion_intent, null);
  assert.equal(masters.filter(master => master.is_default).length, 1);
  assert.equal(masters[0].is_default, true);
  assert.notEqual(saved.master.file_url, "/media/source-hlg.mp4");
  await assert.rejects(api.inspectCompanionSdr({ tempPath: input.sourcePath }, input.metadata), /SDR masters must use BT.709/);
  await assert.rejects(api.inspectCompanionSdr({ tempPath: input.sourcePath }, { masterType: "sdr" }), /requires an HDR/);
});

test("paired SDR accepts PCM source audio and verifies the packaged AAC track", async t => {
  const { api, root } = await fixture(t);
  const source = path.join(root, "pcm-sdr.mov");
  // MOV editing masters often carry PCM even though generated HLS uses AAC.
  await execFile(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.5",
    "-c:v", "libx264", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
    "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-color_range", "tv", "-chroma_sample_location", "left", "-c:a", "pcm_s16le", source]);
  const metadata = api.normalizeUpload({ title: "Fixture", slug: "fixture", masterType: "hlg" });
  const input = await api.inspectCompanionSdr({ tempPath: source, filename: "pcm-sdr.mov" }, metadata);
  assert.equal(input.probe.audio_streams[0].codec_name, "pcm_s16le");
  const saved = await api.saveCompanionSdr(input, { id: 7, title: "Fixture", slug: "fixture" });
  assert.equal(saved.status, "ready");
  assert.equal(saved.master.verification_status, "ready");
  const playlist = path.join(root, saved.hlsUrl.replace("/media/", ""));
  assert.match(await fsp.readFile(playlist, "utf8"), /CODECS="avc1\.[^",]+,mp4a\.40\.2"/);
  assert.equal((await api.probeVideo(playlist)).audio_streams[0].codec_name, "aac");
  api.probeVideo = async () => ({ ...input.probe, codec_name: "mpeg4" });
  await assert.rejects(api.inspectCompanionSdr({ tempPath: source }, metadata), /Unsupported or incomplete video configuration/);
});

test("paired uploads suppress automatic SDR; existing projects never trigger automatic SDR", async t => {
  // Exercise the actual orchestration while isolating file and CMS IO.
  for (const masterType of ["hdr10", "hlg", "dolby_vision"]) {
    for (const existing of [false, true]) {
      for (const supplied of [false, true]) {
        const { api } = await fixture(t);
        let response;
        let automatic = 0;
        let paired = 0;
        const project = { id: 7, slug: "fixture" };
        api.requireUploadAuth = () => {};
        api.parseMultipart = async () => ({ fields: {}, files: supplied ? { sdrVideo: {} } : {}, file: {} });
        api.resolveVideoUploadProject = async () => ({ metadata: { masterType }, project: existing ? project : null });
        api.validateProcessingPolicy = () => {};
        api.inspectCompanionSdr = async file => file ? {} : null;
        api.moveSourceFile = async () => "original.mp4";
        api.parseDolbyProfileFiles = async () => ({});
        api.probeVideo = async () => ({});
        api.validateDolbyVisionUpload = () => {};
        api.buildColorContract = () => ({});
        api.validateColorContract = () => [];
        api.prepareOutputDir = async () => "output";
        api.generateHls = async () => ({});
        api.finalizeHlsOutput = async () => ({ playlistPath: "master.m3u8" });
        api.createOrUpdateDirectusRecords = async (...args) => {
          assert.equal(Boolean(args[6].project), existing);
          return { project, master: { id: 10, type: masterType } };
        };
        api.saveCompanionSdr = async () => { paired++; return { status: "ready", master: { id: 11 } }; };
        api.createDolbySdrMaster = async () => { automatic++; return { status: "ready", master: { id: 12 } }; };
        api.mediaUrlFromPath = value => value;
        api.sendJson = (res, code, body) => { response = { code, body }; };
        await api.handleUpload({ headers: {} }, {});
        assert.equal(response.code, 201);
        assert.equal(paired, Number(supplied));
        assert.equal(automatic, Number(!existing && !supplied));
        assert.equal(response.body.masters.length, supplied || !existing ? 2 : 1);
        if (supplied) {
          api.saveCompanionSdr = async () => { throw new Error("SDR packaging failed"); };
          await api.handleUpload({ headers: {} }, {});
          assert.equal(response.code, 201);
          assert.equal(response.body.companionSdr.status, "failed");
          assert.equal(response.body.project.id, 7);
          assert.equal(response.body.masters.length, 1);
          assert.equal(automatic, 0);
        }
      }
    }
  }
});

test("project discovery requires upload authorization and bounds list results", async t => {
  const { api } = await fixture(t);
  let response;
  api.sendJson = (res, code, body) => { response = { code, body }; };
  api.requireUploadAuth = () => { throw Object.assign(new Error("Unauthorized"), { statusCode: 401 }); };
  await api.handleVideoUploadProjects({}, {}, new URL("http://fixture/uploads/video-projects"));
  assert.equal(response.code, 401);
  api.requireUploadAuth = () => {};
  api.directusRequest = async url => {
    const params = new URL(url, "http://fixture").searchParams;
    assert.equal(params.get("limit"), "21");
    assert.equal(params.get("offset"), "20");
    assert.equal(params.get("search"), "film");
    return { data: Array.from({ length: 21 }, (_, id) => ({ id: id + 1 })) };
  };
  await api.handleVideoUploadProjects({}, {}, new URL("http://fixture/uploads/video-projects?page=2&search=film"));
  assert.equal(response.code, 200);
  assert.equal(response.body.projects.length, 20);
  assert.equal(response.body.hasMore, true);
});

test("a single source picker identifies HDR and SDR in either file order without trusting filenames", async t => {
  const { api } = await fixture(t);
  const hdr = { tempPath: "hdr", filename: "clip.mp4" };
  const sdrFile = { tempPath: "sdr", filename: "clip.mp4" };
  api.probeVideo = async file => ({ color_transfer: file === "hdr" ? "arib-std-b67" : "bt709" });
  for (const videos of [[hdr, sdrFile], [sdrFile, hdr]]) {
    const parsed = { file: videos[0], files: { videos } };
    const metadata = { sourceKind: "embedded", masterType: "sdr", label: "HDR", mode: "copy" };
    await api.identifyPairedSources(parsed, metadata);
    assert.equal(parsed.file, hdr);
    assert.equal(parsed.files.sdrVideo, sdrFile);
    assert.equal(metadata.masterType, "hlg");
    assert.equal(metadata.label, "HLG");
  }
  for (const videos of [[hdr, hdr], [sdrFile, sdrFile]]) {
    await assert.rejects(api.identifyPairedSources({ files: { videos } }, { sourceKind: "embedded", mode: "copy" }), /exactly one HDR/);
  }
  await assert.rejects(api.identifyPairedSources({ files: { videos: [hdr, sdrFile], sdrVideo: sdrFile } },
    { sourceKind: "embedded", mode: "copy" }), /cannot be combined/);
});

test("HDR10 pair inspection finds mastering and content-light SEI on decoded frames", async t => {
  const { api, root } = await fixture(t);
  const source = path.join(root, "hdr10.mp4");
  // These SEI values may be absent from ffprobe's stream-only output.
  await execFile(ffmpeg, [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "0.5",
    "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
    "-x265-params", "log-level=error:pools=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50):max-cll=4000,400",
    "-color_range", "tv", "-chroma_sample_location", "left", source
  ]);
  const probe = await api.probeVideo(source);
  const contract = api.buildColorContract(probe, { masterType: "hdr10" });
  assert.equal(contract.hdrStaticMetadata.contentLightLevel.max_content, 4000);
  assert.equal(contract.hdrStaticMetadata.masteringDisplay.max_luminance, "40000000/10000");
  assert.deepEqual([...api.validateColorContract({ masterType: "hdr10" }, contract)], []);
});

test("Dolby publication rejects sidecar-only claims and preserves actual RPU through fMP4 HLS", async t => {
  const { api, root } = await fixture(t);
  const input = await makeHlgFixture(api, root, false);
  assert.throws(() => api.validateDolbyVisionUpload({ masterType: "dolby_vision" }, input.probe, { profile: "8.4" }), /decodable RPU/);
  const source = path.join(__dirname, "fixtures/dolby-p8.mp4");
  const metadata = { masterType: "dolby_vision", mode: "copy" };
  const probe = await api.probeVideo(source);
  const contract = api.buildColorContract(probe, metadata);
  assert.equal(contract.dolbyMetadata.rpuCount, 12);
  assert.equal(contract.dolbyMetadata.decodedMetadataPresent, true);
  assert.doesNotThrow(() => api.validateDolbyVisionUpload(metadata, probe, {}));
  const outDir = path.join(root, "dolby"); await fsp.mkdir(outDir);
  const output = await api.generateHls(source, outDir, metadata, probe);
  const final = await api.finalizeHlsOutput(output, metadata, contract, {}, probe);
  assert.equal(final.outputContract.dolbyMetadata.rpuSha256, contract.dolbyMetadata.rpuSha256);
  assert.match(await fsp.readFile(final.playlistPath, "utf8"), /SUPPLEMENTAL-CODECS="dvh1.08.01\/db1p"/);
  const stripped = path.join(root, "stripped.mp4");
  await execFile(ffmpeg, ["-v", "error", "-y", "-i", source, "-c:v", "copy",
    "-bsf:v", "filter_units=remove_types=62", "-strict", "unofficial", stripped]);
  const strippedProbe = await api.probeVideo(stripped);
  assert.throws(() => api.validateDolbyVisionUpload(metadata, strippedProbe, { profile: "8.1" }), /RPU/);
  const broken = structuredClone(probe);
  broken.dovi_rpu_integrity.count = 0;
  assert.throws(() => api.validateDolbyVisionUpload(metadata, broken, { profile: "8.1" }), /verified RPU/);
  const changed = structuredClone(contract);
  changed.dolbyMetadata.rpuSha256 = "lost";
  assert.ok(api.compareColorContracts(contract, changed).some(message => /rpuSha256/.test(message)));
  const conversion = sdr.buildDolbySdrConversion(contract, new Set(["libplacebo"]));
  const converted = path.join(root, "dolby-sdr.mp4");
  await execFile(ffmpeg, sdr.buildSdrEncodeArgs(source, converted, conversion));
  const sdrContract = api.buildColorContract(await api.probeVideo(converted), { masterType: "sdr" });
  assert.deepEqual(sdr.validateSdrDerivative(sdrContract, contract), []);
});

test("SDR transcode changes matrix pixels rather than merely relabeling them", async t => {
  const { api, root } = await fixture(t);
  const raw = path.join(root, "red.yuv");
  // BT.601 limited-range encoding of BT.709 red: Y=0.299, Cb=-0.1687, Cr=0.5.
  const pixels = Buffer.alloc(16 * 16 * 3);
  for (let i = 0; i < 384; i++) pixels.writeUInt16LE(i < 256 ? 326 : i < 320 ? 361 : 960, i * 2);
  await fsp.writeFile(raw, pixels);
  const source = path.join(root, "red.mp4");
  await execFile(ffmpeg, ["-v", "error", "-y", "-f", "rawvideo", "-pixel_format", "yuv420p10le", "-video_size", "16x16", "-i", raw,
    "-c:v", "libx265", "-preset", "ultrafast", "-x265-params",
    "log-level=error:pools=1:lossless=1:colorprim=bt709:transfer=bt709:colormatrix=smpte170m", "-chroma_sample_location", "left", source]);
  const probe = await api.probeVideo(source);
  const out = path.join(root, "mapped"); await fsp.mkdir(out);
  const output = await api.generateHls(source, out, { masterType: "sdr", mode: "transcode" }, probe);
  const { stdout } = await execFile(ffmpeg, ["-v", "error", "-i", output.mediaPlaylistPath, "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
  // BT.709 red has Y'=0.2126, hence 16 + 219*0.2126 ~= 63 (not the old ~82).
  assert.ok(Math.abs(stdout[0] - 63) <= 2, `Incorrect converted red luma: ${stdout[0]}`);
});

test("SDR transcode preserves the display dimensions of rotated source videos", async t => {
  const { api, root } = await fixture(t);
  const original = path.join(root, "landscape.mp4");
  await execFile(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "0.5",
    "-c:v", "libx264", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
    "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-color_range", "tv", "-chroma_sample_location", "left", original]);
  for (const rotation of [90, 270]) {
    const source = path.join(root, `rotated-${rotation}.mp4`);
    // Set real container display metadata instead of transposing the source pixels.
    await execFile(ffmpeg, ["-v", "error", "-y", "-display_rotation", String(rotation), "-i", original, "-c", "copy", source]);
    const probe = await api.probeVideo(source);
    const metadata = { masterType: "sdr", mode: "transcode" };
    const contract = api.buildColorContract(probe, metadata);
    assert.equal(probe.width, 160);
    assert.equal(probe.height, 90);
    assert.ok(probe.side_data_list.some(item => Math.abs(item.rotation) === 90));
    const out = path.join(root, `portrait-${rotation}`); await fsp.mkdir(out);
    const output = await api.generateHls(source, out, metadata, probe);
    const result = await api.finalizeHlsOutput(output, metadata, contract, {}, probe);
    assert.equal(result.outputContract.width, 90);
    assert.equal(result.outputContract.height, 160);
    assert.equal(result.verification.status, "ready");
  }
});

test("SDR transcode changes codec/depth intentionally and converts full-range BT.601 to BT.709", async t => {
  const { api, root } = await fixture(t);
  const source = path.join(root, "sdr-601.mp4");
  await execFile(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "0.5",
    "-vf", "setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m:range=full",
    "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
    "-x265-params", "log-level=error:pools=1:colorprim=smpte170m:transfer=smpte170m:colormatrix=smpte170m:range=full",
    "-chroma_sample_location", "left", source]);
  const metadata = { masterType: "sdr", mode: "transcode" };
  const probe = await api.probeVideo(source);
  const contract = api.buildColorContract(probe, metadata);
  assert.equal(contract.colorPrimaries, "smpte170m");
  assert.equal(contract.colorRange, "full");
  assert.deepEqual([...api.validateColorContract(metadata, contract, "source")], []);
  const dir = path.join(root, "transcoded"); await fsp.mkdir(dir);
  const output = await api.generateHls(source, dir, metadata, probe);
  const result = await api.finalizeHlsOutput(output, metadata, contract, {}, probe);
  assert.equal(result.outputContract.codecName, "h264");
  assert.equal(result.outputContract.bitDepth, 8);
  assert.equal(result.outputContract.colorRange, "limited");
  assert.equal(result.outputContract.colorPrimaries, "bt709");
  assert.equal(result.verification.conversion.engine, "zscale");
  assert.match(result.verification.conversion.filter, /matrixin=smpte170m/);
  assert.ok(api.compareColorContracts(contract, result.outputContract).length, "Copy still rejects these changes");
});

test("Profile 5 retains its Dolby sample entry and converts through embedded RPU", async t => {
  const { api, root } = await fixture(t);
  const source = path.join(__dirname, "fixtures/dolby-p5.mp4");
  const probe = await api.probeVideo(source);
  const metadata = { masterType: "dolby_vision", mode: "copy" };
  const contract = api.buildColorContract(probe, metadata);
  assert.equal(contract.dolbyMetadata.profile, "5");
  assert.equal(contract.dolbyMetadata.rpuCount, 12);
  assert.doesNotThrow(() => api.validateDolbyVisionUpload(metadata, probe, {}));
  const dir = path.join(root, "p5"); await fsp.mkdir(dir);
  const output = await api.generateHls(source, dir, metadata, probe);
  const final = await api.finalizeHlsOutput(output, metadata, contract, {}, probe);
  assert.match(await fsp.readFile(final.playlistPath, "utf8"), /CODECS="dvh1.05.01"/);
  const conversion = sdr.buildDolbySdrConversion(contract, new Set(["libplacebo"]));
  assert.equal(conversion.usesDolbyMetadata, true);
  const target = path.join(root, "p5-sdr.mp4");
  await execFile(ffmpeg, sdr.buildSdrEncodeArgs(source, target, conversion));
  assert.deepEqual(sdr.validateSdrDerivative(api.buildColorContract(await api.probeVideo(target), { masterType: "sdr" }), contract), []);
});

test("wide-gamut SDR transcode uses perceptual gamut mapping without HDR peak expansion", async t => {
  const { api, root } = await fixture(t);
  const source = path.join(root, "p3-sdr.mp4");
  await execFile(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "0.5",
    "-vf", "setparams=color_primaries=smpte432:color_trc=bt709:colorspace=bt709:range=limited",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-chroma_sample_location", "left", source]);
  const probe = await api.probeVideo(source);
  const metadata = { masterType: "sdr", mode: "transcode" };
  const contract = api.buildColorContract(probe, metadata);
  const dir = path.join(root, "p3-out"); await fsp.mkdir(dir);
  const output = await api.generateHls(source, dir, metadata, probe);
  const result = await api.finalizeHlsOutput(output, metadata, contract, {}, probe);
  assert.equal(result.verification.conversion.engine, "libplacebo");
  assert.match(result.verification.conversion.filter, /gamut_mode=perceptual/);
  assert.match(result.verification.conversion.filter, /peak_detect=false/);
  assert.deepEqual(sdr.validateSdrDerivative(result.outputContract, contract), []);
});
