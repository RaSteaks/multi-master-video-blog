const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const crypto = require("node:crypto");
const sdr = require("../src/video-sdr.cjs");
const hls = require("../src/hls-metadata.cjs");
const ffmpeg = require("ffmpeg-static");
const ffprobe = require("ffprobe-static").path;

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "video-sdr-"));
  assert.equal(path.dirname(root), os.tmpdir());
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await fsp.readFile(path.join(__dirname, "../src/server.cjs"), "utf8");
  const names = [
    "httpError", "runProcess", "withLocalHlsInput", "probeMediaStreams", "probeVideo", "prepareOutputDir", "assertInside", "safePathSegment",
    "availableVideoSdrFilters", "createDolbySdrMaster", "generateHls", "isHevcCodec",
    "buildColorContract", "normalizePrimaries", "normalizeTransfer", "normalizeMatrix", "normalizeRange",
    "normalizeColorToken", "extractHdrStaticMetadata", "extractDolbyVisionMetadata", "firstDefined",
    "stringOrNull", "booleanOrFalse", "inferBitDepth", "defaultBitDepth", "expectedVideoRange",
    "normalizeHlsVideoRange", "normalizeDolbyProfileVersion", "normalizeNumberLabel", "parseInteger", "validateColorContract", "validateHdrGamut",
    "compareColorContracts", "throwColorContractError", "finalizeHlsOutput", "writeMultivariantPlaylist",
    "serializeHlsAttributeList", "stampHlsPlaylist", "writeVerificationReport", "inspectHlsMediaFiles",
    "localHlsPath", "stripUriQuery", "parseHlsAttributeList", "prepareHlsPackageOutput", "copiedHlsVariants",
    "copiedHlsMasterTags", "rebaseHlsUri", "primaryMediaPlaylistPath", "parseVariantUris", "parseStreamInfoVariants",
    "summarizeProbe", "createOrUpdateDirectusRecords", "findMastersByIdentity", "clearDefaultMasters",
    "sha256File", "mediaUrlFromPath", "prettyCodec", "prettyColorSpace", "prettyTransferFunction",
    "defaultCodec", "defaultColorSpace", "defaultTransferFunction", "defaultLabel", "handleUpload"
  ];
  const declarations = names.map(name => {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  const masters = [{ id: 10, type: "dolby_vision", project_id: 7, is_default: true }];
  let nextId = 11;
  const context = vm.createContext({
    ...sdr, ...hls, fs, fsp, path, spawn, setTimeout, clearTimeout, crypto, URLSearchParams,
    REPO_ROOT: root, MEDIA_ROOT: root, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe,
    VIDEO_SDR_PROCESS_TIMEOUT_MS: 30000,
    HDR_MASTER_TYPES: new Set(["hdr10", "hlg", "dolby_vision"]),
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

async function makeHlgFixture(api, root, withAudio = true) {
  const sourcePath = path.join(root, "source-hlg.mp4");
  await execFile(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24",
    ...(withAudio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []), "-t", "0.5",
    "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:pools=1",
    "-pix_fmt", "yuv420p10le", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67",
    "-colorspace", "bt2020nc", "-color_range", "tv", "-chroma_sample_location", "left",
    ...(withAudio ? ["-c:a", "aac"] : []), sourcePath
  ], { windowsHide: true });
  const probe = await api.probeVideo(sourcePath);
  const metadata = { title: "Fixture", slug: "fixture", label: "Dolby Vision", masterType: "dolby_vision", isDefault: true, published: false };
  // Synthetic HEVC/HLG base layer, with a trusted profile sidecar; no claim of a real RPU fixture.
  const contract = api.buildColorContract(probe, metadata, { profile: "8.4", compatibilityId: "4" });
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
    conversion_intent: sdr.AUTO_SDR_CONVERSION, source_sha256: "previous-source",
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
  await api.handleUpload({}, {});
  assert.equal(response.code, 201);
  assert.equal(response.body.master.type, "dolby_vision");
  assert.equal(response.body.sdrDerivative.status, "failed");
  assert.equal(response.body.masters.length, 1);
});
