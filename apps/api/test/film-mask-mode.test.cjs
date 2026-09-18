const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const utils = require("../src/film-scan-utils.cjs");
const source = fs.readFileSync(path.join(__dirname, "../src/server.cjs"), "utf8");
const names = ["resolveFilmScanRollAdjustments", "resolveFilmScanPreviewAdjustments",
  "findFilmStockPresetMask", "replaceFilmScanMaskWarnings", "pickFilmScanJobPatch", "handleFilmScanJobPatch"];
const declarations = names.map(name => {
  const match = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
  assert.ok(match, name);
  return match[0];
}).join("\n");
const sampled = [0.82, 0.61, 0.39];
const preset = [0.9, 0.7, 0.5];
const typed = [0.5, 0.4, 0.3];
const point = { x: 0.1, y: 0.2, sourceId: 2 };
const plain = value => JSON.parse(JSON.stringify(value));
function image(rgb) {
  return { width: 64, height: 64, channels: 3, data: Buffer.from(Array.from({ length: 4096 }, () => rgb).flat()) };
}
function fixture(overrides = {}) {
  const calls = { sample: [], analysis: [], preset: 0, writes: [] };
  let job = { id: 1, status: "review_required", film_type: "color-negative", frame_format: "135-full",
    scanner: "hasselblad-x5", film_stock: "Kodak Portra 400", roll_adjustments: { maskMode: "manual", maskRgb: typed }, warnings: [] };
  let body = {};
  const context = vm.createContext({
    ...utils, URLSearchParams,
    jsonObject: value => value || {}, jsonArray: value => value || [],
    directusRelationId: value => value?.id ?? value, filmScanSourcePath: value => value,
    httpError: (status, message) => Object.assign(new Error(message), { statusCode: status }),
    listFilmScanSources: async () => [{ id: 1, relative_path: "blocked" }, { id: 2, relative_path: "clean" }],
    listFilmScanFrames: async () => [],
    createAnalysisImage: async name => { calls.analysis.push(name); return image(name === "blocked" ? [0, 0, 0] : [210, 156, 100]); },
    sampleFilmBaseAtPoint: async (file, sample) => { calls.sample.push({ file, sample }); return sampled; },
    directusRequest: async () => {
      calls.preset++;
      return { data: [
        { manufacturer: "Kodak", model: "Portra 400", scanner: null, parameters: { maskRgb: [0.8, 0.6, 0.4] } },
        { manufacturer: "Kodak", model: "Portra 400", scanner: "hasselblad-x5", parameters: { maskRgb: preset } }
      ] };
    },
    directusLogin: async () => "token", readJsonBody: async () => body,
    getFilmScanJobRecord: async () => job,
    updateFilmScanJob: async (token, id, patch) => { calls.writes.push(plain(patch)); job = { ...job, ...patch }; },
    serializeFilmScanJob: value => value, sendJson: () => {},
    ...overrides
  });
  vm.runInContext(declarations, context);
  return { api: context, calls, job: () => job, setBody: value => { body = value; } };
}

test("switching from manual to auto replaces stale RGB and ignores the old sample point", async () => {
  const f = fixture();
  const result = await f.api.resolveFilmScanPreviewAdjustments("token", f.job(), {},
    { maskMode: "auto", maskRgb: typed, filmBaseSample: point, exposure: 1 }, {});
  assert.deepEqual(plain(result.roll.maskRgb), [210, 156, 100].map(v => v / 255));
  assert.equal(result.roll.filmBaseSample, null);
  assert.equal(result.adjustments.exposure, 1);
  assert.equal(f.calls.sample.length, 0);
  assert.deepEqual(f.calls.analysis, ["blocked", "clean"]);
});

test("preset mode resolves the matching scanner instead of keeping manual or automatic RGB", async () => {
  const f = fixture();
  const result = await f.api.resolveFilmScanPreviewAdjustments("token", f.job(), {},
    { maskMode: "preset", maskRgb: typed, filmBaseSample: point }, {});
  assert.deepEqual(plain(result.roll.maskRgb), preset);
  assert.equal(result.roll.filmBaseSample, null);
  assert.equal(f.calls.preset, 1);
  assert.equal(f.calls.sample.length, 0);
  assert.equal(f.calls.analysis.length, 0);
});

test("unreliable auto sampling falls back to a preset with a warning", async () => {
  const f = fixture({ createAnalysisImage: async () => image([0, 0, 0]) });
  const result = await f.api.resolveFilmScanRollAdjustments("token", f.job(), { maskMode: "auto", maskRgb: typed });
  assert.equal(result.roll.maskMode, "preset");
  assert.deepEqual(plain(result.roll.maskRgb), preset);
  assert.match(result.warnings[0], /回退/);
});

test("missing presets clear stale RGB and report the generic fallback in both modes", async () => {
  const f = fixture({ createAnalysisImage: async () => image([0, 0, 0]), directusRequest: async () => ({ data: [] }) });
  for (const maskMode of ["auto", "preset"]) {
    const result = await f.api.resolveFilmScanRollAdjustments("token", f.job(), { maskMode, maskRgb: typed });
    assert.equal(result.roll.maskRgb, null);
    assert.match(result.warnings[0], /通用彩负基准/);
  }
});

test("point sampling still uses its source and explicit RGB takes over after clearing the point", async () => {
  const f = fixture();
  const result = await f.api.resolveFilmScanRollAdjustments("token", f.job(), { maskMode: "manual", filmBaseSample: point });
  assert.deepEqual(plain(result.roll.maskRgb), sampled);
  assert.equal(f.calls.sample[0].file, "clean");
  const edited = await f.api.resolveFilmScanRollAdjustments("token", f.job(), { ...result.roll, maskRgb: typed, filmBaseSample: null });
  assert.deepEqual(plain(edited.roll.maskRgb), typed);
  assert.equal(f.calls.sample.length, 1);
});

for (const maskMode of ["auto", "preset", "manual"]) {
  test(maskMode + " preview and saved roll use the same resolved mask", async () => {
    const f = fixture();
    const draft = { maskMode, maskRgb: typed, filmBaseSample: null, exposure: 0.5 };
    const preview = await f.api.resolveFilmScanPreviewAdjustments("token", f.job(), {}, draft, {});
    f.setBody({ rollAdjustments: draft });
    await f.api.handleFilmScanJobPatch({}, {}, 1, 1);
    assert.deepEqual(plain(f.job().roll_adjustments), plain(preview.roll));
    assert.equal(f.calls.writes.length, 1);
    const committed = utils.mergeFrameAdjustments(f.job().roll_adjustments, {});
    assert.deepEqual(committed.maskRgb, plain(preview.adjustments.maskRgb));
  });
}

test("preset lookup failure leaves the saved roll untouched", async () => {
  const f = fixture({ directusRequest: async () => { throw new Error("preset store unavailable"); } });
  f.setBody({ rollAdjustments: { maskMode: "preset", maskRgb: typed } });
  await assert.rejects(f.api.handleFilmScanJobPatch({}, {}, 1, 1), /unavailable/);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.job().roll_adjustments.maskMode, "manual");
});

test("initial analysis reuses its automatic result without decoding twice", async () => {
  const f = fixture();
  const result = await f.api.resolveFilmScanRollAdjustments("token", f.job(), { maskMode: "auto" }, { automaticMask: sampled });
  assert.deepEqual(plain(result.roll.maskRgb), sampled);
  assert.equal(f.calls.analysis.length, 0);
});

test("successful mode changes clear stale mask warnings while preserving crop warnings", () => {
  const f = fixture();
  const warnings = f.api.replaceFilmScanMaskWarnings({ warnings: ["帧 1 需要确认裁切", "未找到可靠片基区域，已回退。", "未找到匹配的扫描仪与胶卷预设，已使用通用彩负基准。"] }, []);
  assert.deepEqual(plain(warnings), ["帧 1 需要确认裁切"]);
});

test("non-color-negative jobs do not sample or load color-negative presets", async () => {
  const f = fixture();
  for (const film_type of ["slide", "bw-negative"]) {
    await f.api.resolveFilmScanRollAdjustments("token", { ...f.job(), film_type }, { maskMode: "auto" });
  }
  assert.equal(f.calls.analysis.length, 0);
  assert.equal(f.calls.preset, 0);
});


test("saved previews keep the committed mask snapshot when presets change", async () => {
  const f = fixture();
  const job = { ...f.job(), roll_adjustments: { maskMode: "preset", maskRgb: typed }, warnings: ["帧 1 需要确认裁切"] };
  const result = await f.api.resolveFilmScanPreviewAdjustments("token", job, {}, undefined, {});
  assert.deepEqual(plain(result.adjustments.maskRgb), typed);
  assert.equal(f.calls.preset, 0);
  assert.deepEqual(plain(f.api.replaceFilmScanMaskWarnings(job, result.warnings)), job.warnings);
});


test("tone-only edits reuse the saved auto mask, but switching back with cleared RGB samples again", async () => {
  const f = fixture();
  const job = { ...f.job(), roll_adjustments: { maskMode: "auto", maskRgb: sampled } };
  const tone = await f.api.resolveFilmScanRollAdjustments("token", job, { ...job.roll_adjustments, exposure: 1 });
  assert.deepEqual(plain(tone.roll.maskRgb), sampled);
  assert.equal(f.calls.analysis.length, 0);
  const switched = await f.api.resolveFilmScanRollAdjustments("token", job, { maskMode: "auto", maskRgb: null });
  assert.deepEqual(plain(switched.roll.maskRgb), [210, 156, 100].map(v => v / 255));
  assert.deepEqual(f.calls.analysis, ["blocked", "clean"]);
});


test("conflicting automatic source masks fall back to the scanner preset", async () => {
  const f = fixture({ createAnalysisImage: async name => image(name === "blocked" ? [229, 140, 76] : [179, 166, 102]) });
  const result = await f.api.resolveFilmScanRollAdjustments("token", f.job(), { maskMode: "auto", maskRgb: null });
  assert.equal(result.roll.maskMode, "preset");
  assert.deepEqual(plain(result.roll.maskRgb), preset);
  assert.match(result.warnings[0], /回退/);
});
