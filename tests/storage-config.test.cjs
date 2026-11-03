const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { configureStorage, loadStorageEnvironment } = require("../config/storage.cjs");

const shared = { STORAGE_LOCATIONS: "oss,local", STORAGE_OSS_DRIVER: "s3", STORAGE_OSS_BUCKET: "fixture-bucket", STORAGE_OSS_REGION: "cn-hangzhou",
  STORAGE_OSS_ENDPOINT: "https://s3.oss-cn-hangzhou.aliyuncs.com", STORAGE_OSS_ROOT: "blog_all", STORAGE_OSS_KEY: "fixture-key", STORAGE_OSS_SECRET: "fixture-secret" };

test("one OSS configuration routes article, album and video assets while preserving legacy readers", () => {
  const env = configureStorage(shared);
  assert.equal(env.VIDEO_STORAGE, "oss");
  assert.equal(env.VIDEO_OSS_ROOT, "blog_all/videos");
  assert.equal(env.STORAGE_LOCATIONS, "oss,local,oss_article,oss_album,oss_video");
  for (const [location, prefix] of [["OSS_ARTICLE", "article"], ["OSS_ALBUM", "album"], ["OSS_VIDEO", "videos"]]) {
    assert.equal(env[`STORAGE_${location}_ROOT`], `blog_all/${prefix}/assets`);
    assert.equal(env[`STORAGE_${location}_BUCKET`], shared.STORAGE_OSS_BUCKET);
    assert.equal(env[`STORAGE_${location}_KEY`], shared.STORAGE_OSS_KEY);
    assert.equal(env[`STORAGE_${location}_SECRET`], shared.STORAGE_OSS_SECRET);
  }
  assert.equal(env.STORAGE_OSS_ROOT, "blog_all");
  assert.equal(configureStorage({ ...shared, STORAGE_OSS_ROOT: "legacy-files" }).VIDEO_OSS_ROOT, "legacy-files/videos");
  assert.equal(configureStorage({ ...shared, STORAGE_LOCATIONS: "oss,local", STORAGE_OSS_ROOT: "" }).STORAGE_OSS_ROOT, "");
  assert.equal(configureStorage({ ...shared, STORAGE_OSS_ROOT: "" }).VIDEO_OSS_ROOT, "videos");
  assert.deepEqual(configureStorage(env), env);
  assert.equal(configureStorage({ ...shared, CONTENT_STORAGE: "local", OSS_BUCKET: "unused" }).VIDEO_OSS_BUCKET, "fixture-bucket");
});

test("legacy native storage settings remain valid and invalid shared configurations fail before startup", () => {
  const native = { VIDEO_STORAGE: "oss", STORAGE_LOCATIONS: "local,oss" };
  assert.equal(configureStorage(native), native);
  for (const changes of [{ STORAGE_OSS_REGION: "" }, { STORAGE_OSS_SECRET: "" }, { STORAGE_OSS_ROOT: "../private" },
    { STORAGE_OSS_ENDPOINT: "https://user:password@fixture.invalid" }, { STORAGE_OSS_DRIVER: "local" }]) {
    assert.throws(() => configureStorage({ ...shared, ...changes }));
  }
});

test("API reads storage from the CMS file without inheriting its port or database/admin credentials", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "content-storage-config-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const common = path.join(dir, "cms.env"), api = path.join(dir, "api.env");
  await fs.writeFile(common, Object.entries(shared).map(([key, value]) => `${key}=${value}`).join("\n")
    + "\nPORT=8055\nDB_PASSWORD=cms-db-fixture\nADMIN_PASSWORD=cms-admin-fixture\n");
  await fs.writeFile(api, "PORT=8060\nVIDEO_STORAGE=local\nDIRECTUS_PASSWORD=api-service-fixture\n");
  const apiEnv = loadStorageEnvironment(api, {}, common);
  const cmsEnv = loadStorageEnvironment(common, {}, common);
  assert.equal(apiEnv.VIDEO_OSS_BUCKET, cmsEnv.STORAGE_OSS_ALBUM_BUCKET);
  assert.equal(apiEnv.VIDEO_STORAGE, "oss");
  assert.equal(cmsEnv.STORAGE_LOCATIONS.split(",")[0], "oss");
  assert.equal(apiEnv.PORT, "8060");
  assert.equal(apiEnv.DB_PASSWORD, undefined);
  assert.equal(apiEnv.ADMIN_PASSWORD, undefined);
  assert.equal(apiEnv.DIRECTUS_PASSWORD, "api-service-fixture");
  assert.equal(loadStorageEnvironment(api, { CMS_ENV_FILE: common }).VIDEO_OSS_ROOT, "blog_all/videos");
  assert.throws(() => loadStorageEnvironment(api, { CMS_ENV_FILE: path.join(dir, "missing.env") }), /CMS_ENV_FILE/);
  assert.equal(loadStorageEnvironment(api, { STORAGE_OSS_BUCKET: "process-bucket" }, common).VIDEO_OSS_BUCKET, "process-bucket");
});
