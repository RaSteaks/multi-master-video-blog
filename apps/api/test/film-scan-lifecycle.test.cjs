const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "film-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await fs.readFile(path.join(__dirname, "../src/server.cjs"), "utf8");
  const names = ["enqueueFilmScanPreview", "filmScanJobDirectory", "saveFilmScanRollback",
    "cleanupFilmScanPartialCommit", "cleanupFilmScanJobAssets", "cleanupFilmScanJobAssetsNow",
    "rerenderFilmScanFrame", "handleFilmScanCancel"];
  const declarations = names.map(name => {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  const context = vm.createContext({
    fsp: fs, path, FILM_SCAN_ROOT: root, URLSearchParams,
    console: { error() {} }, assertInside() {},
    ALBUM_PHOTO_FIELDS: "*", directusFileId: value => value,
    directusRelationId: value => value, listFilmScanFrames: async () => [],
    listFilmScanSources: async () => [], directusRequest: async () => ({ data: [] }),
    filmScanCanceledError: () => new Error("canceled"),
    ...overrides
  });
  vm.runInContext("let filmScanPreviewTail = Promise.resolve();\n" + declarations, context);
  return { api: context, root };
}

test("photo deletion failure preserves frames and rollback IDs until retry succeeds", async t => {
  let fail = true;
  let photo = { id: 7, sdr_image: "image" };
  const deleted = [];
  const { api, root } = await fixture(t, {
    listFilmScanFrames: async () => [{ id: 2 }],
    directusRequest: async (url, token, options) => {
      if (!options) return { data: photo ? [photo] : [] };
      if (url === "/items/album_photos/7") {
        if (fail) throw new Error("temporary database failure");
        photo = null;
      }
      deleted.push(url);
      return {};
    }
  });
  const first = await api.cleanupFilmScanJobAssets("token", 1, "test");
  assert.equal(first.metadataDeleted, false);
  assert.equal(deleted.length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "1/rollback.json"), "utf8")).files, ["image"]);
  fail = false;
  const second = await api.cleanupFilmScanJobAssets("token", 1, "retry");
  assert.equal(second.metadataDeleted, true);
  assert.ok(deleted.includes("/files/image"));
  assert.ok(deleted.includes("/items/film_scan_frames/2"));
  await assert.rejects(fs.access(path.join(root, "1")), { code: "ENOENT" });
});

test("unattached uploaded file remains recoverable across a restart", async t => {
  let fail = true;
  const deleted = [];
  const { api, root } = await fixture(t, {
    directusRequest: async url => {
      if (fail) throw new Error("storage unavailable");
      deleted.push(url);
      return {};
    }
  });
  await api.saveFilmScanRollback(1, { files: ["unattached"] });
  assert.equal((await api.cleanupFilmScanJobAssets("token", 1, "first")).filesDeleted, false);
  // All information required for recovery is on disk, without photo/frame relations.
  const { api: restarted } = await fixture(t);
  restarted.FILM_SCAN_ROOT = root;
  restarted.directusRequest = async url => { deleted.push(url); return {}; };
  fail = false;
  assert.equal((await restarted.cleanupFilmScanJobAssets("token", 1, "restart")).filesDeleted, true);
  assert.deepEqual(deleted, ["/files/unattached"]);
});

test("cleanup waits for an active preview and queued stale previews cannot recreate files", async t => {
  let status = "review_required";
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let renders = 0;
  const { api, root } = await fixture(t, {
    directusRequest: async () => ({ data: { status } }),
    renderFilmScanFramePreviewNow: async () => {
      renders++;
      started();
      await gate;
      await fs.mkdir(path.join(root, "1"), { recursive: true });
      await fs.writeFile(path.join(root, "1/preview.jpg"), "preview");
    }
  });
  const preview = api.rerenderFilmScanFrame("token", { id: 1 }, {});
  await ready;
  status = "canceled";
  let finished = false;
  const cleanup = api.cleanupFilmScanJobAssets("token", 1, "cancel").then(result => {
    finished = true;
    return result;
  });
  const stale = assert.rejects(api.rerenderFilmScanFrame("token", { id: 1 }, {}), /canceled/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await preview;
  assert.equal((await cleanup).filesDeleted, true);
  await stale;
  assert.equal(renders, 1);
  await assert.rejects(fs.access(path.join(root, "1")), { code: "ENOENT" });
});

test("cancel defers cleanup to an active worker and reports pending deletion", async t => {
  const controller = new AbortController();
  let response;
  const { api } = await fixture(t, {
    directusLogin: async () => "token",
    getFilmScanJobRecord: async () => ({ status: "rendering" }),
    filmScanJobControllers: new Map([["1", controller]]),
    updateFilmScanJob: async () => {},
    filmScanQueue: [],
    sendJson: (res, code, body) => { response = { code, body }; }
  });
  api.cleanupFilmScanJobAssets = async () => { throw new Error("must wait for worker"); };
  await api.handleFilmScanCancel({}, 1, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(response.code, 202);
  assert.equal(response.body.filesDeleted, false);
});

test("file deletion failure after photo removal keeps the file ID for the next cleanup", async t => {
  let photo = { id: 7, sdr_image: "remaining-file" };
  let failFile = true;
  const deletedFiles = [];
  const { api, root } = await fixture(t, {
    listFilmScanFrames: async () => [{ id: 2 }],
    directusRequest: async (url, token, options) => {
      if (!options) return { data: photo ? [photo] : [] };
      if (url === "/items/album_photos/7") photo = null;
      if (url === "/files/remaining-file") {
        if (failFile) throw new Error("temporary storage failure");
        deletedFiles.push(url);
      }
      return {};
    }
  });
  assert.equal((await api.cleanupFilmScanJobAssets("token", 1, "first")).metadataDeleted, false);
  assert.equal(photo, null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "1/rollback.json"), "utf8")).files, ["remaining-file"]);
  failFile = false;
  assert.equal((await api.cleanupFilmScanJobAssets("token", 1, "retry")).metadataDeleted, true);
  assert.equal(deletedFiles.length, 1);
});

test("cleanup without a token preserves an existing rollback ledger", async t => {
  const { api, root } = await fixture(t);
  await api.saveFilmScanRollback(1, { files: ["pending-file"] });
  assert.equal((await api.cleanupFilmScanJobAssets(null, 1, "offline")).filesDeleted, false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "1/rollback.json"), "utf8")).files, ["pending-file"]);
});
