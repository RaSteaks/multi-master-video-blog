const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createContentArchive } = require("../src/content-archive.cjs");

async function fixture(t, storageRoot = "blog_all") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "content-archive-"));
  const objects = new Map();
  const data = {
    posts: [{ id: 1, slug: "article", title: "文章", content: "# 正文\n![图](/api/assets/image-1)", cover_image: "image-1" }],
    albums: [{ id: 2, slug: "album", title: "相簿", description: "描述" }],
    album_photos: [{ id: 3, album_id: 2, sdr_image: "image-2", sort_order: 0,
      renditions: [{ id: 4, kind: "hlg", file: "image-3" }] }],
    album_photo_renditions: [{ id: 4, photo_id: 3, file: "image-3" }],
    video_projects: [{ id: 5, slug: "film", title: "视频" }],
    video_masters: [{ id: 6, project_id: 5, hls_url: "/media/film/sdr/v1/master.m3u8" }],
    files: [
      { id: "image-1", storage: "oss_article", filename_disk: "image-1.png" },
      { id: "image-2", storage: "oss_album", filename_disk: "image-2.jpg" },
      { id: "image-3", storage: "oss_album", filename_disk: "image-3.avif" }
    ]
  };
  const objectStore = {
    async write({ key, bytes, sha256 }) { objects.set(key, { bytes, sha256 }); },
    async stat(key) { const item = objects.get(key); return item ? { size: item.bytes.length, sha256: item.sha256 } : null; }
  };
  const request = async route => {
    const url = new URL(route, "http://fixture");
    const [, first, second, third] = url.pathname.split("/");
    const collection = first === "files" ? "files" : second;
    const id = first === "files" ? second : third;
    if (id) {
      const row = data[collection].find(item => String(item.id) === id);
      if (!row) throw Object.assign(new Error("not found"), { statusCode: 404 });
      return { data: structuredClone(row) };
    }
    let rows = data[collection];
    for (const [key, value] of url.searchParams) {
      const match = key.match(/^filter\[(\w+)\]\[_eq\]$/);
      if (match) rows = rows.filter(row => String(row[match[1]]) === value);
    }
    const offset = Number(url.searchParams.get("offset") || 0);
    return { data: structuredClone(rows.slice(offset, offset + 100)) };
  };
  const config = { root: storageRoot };
  const archive = createContentArchive({ config, journalRoot: root, request, objectStore });
  await archive.init();
  t.after(async () => { await archive.close(); await fs.rm(root, { recursive: true, force: true }); });
  const latest = kind => {
    const key = { article: "blog_all/article/1/latest.json", album: "blog_all/album/2/latest.json",
      videos: "blog_all/videos/film/metadata/latest.json" }[kind];
    const pointer = JSON.parse(objects.get(key).bytes);
    return { pointer, snapshot: JSON.parse(objects.get(pointer.metadataKey).bytes) };
  };
  return { root, config, data, objects, objectStore, request, archive, latest };
}

test("shared storage archives article Markdown, album/HDR assets and video metadata in the requested hierarchy", async t => {
  const f = await fixture(t);
  assert.equal(await f.archive.flush(), false);
  const article = f.latest("article"), album = f.latest("album"), video = f.latest("videos");
  assert.equal(f.objects.get(article.pointer.contentKey).bytes.toString(), f.data.posts[0].content);
  assert.equal(article.snapshot.files[0].object_key, "blog_all/article/assets/image-1.png");
  assert.equal(album.snapshot.photos[0].sort_order, 0);
  assert.deepEqual(album.snapshot.files.map(file => file.object_key), ["blog_all/album/assets/image-2.jpg", "blog_all/album/assets/image-3.avif"]);
  assert.equal(video.snapshot.masters[0].hls_url, "/media/film/sdr/v1/master.m3u8");
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal((await f.archive.status()).pending, 0);
  const invalid = await f.archive.before({ pathname: "/items/posts", method: "POST" });
  await assert.rejects(f.archive.after(invalid, {}), /Invalid content archive owner/);
});

test("photo deletion captures its album before removal and records the updated album without deleting OSS history", async t => {
  const f = await fixture(t); await f.archive.flush();
  const old = f.latest("album").pointer.metadataKey;
  const mutation = await f.archive.before({ pathname: "/items/album_photos/3", method: "DELETE" });
  f.data.album_photos = [];
  await f.archive.after(mutation);
  assert.equal(await f.archive.flush(), false);
  assert.deepEqual(f.latest("album").snapshot.photos, []);
  assert.ok(f.objects.has(old));
});

test("an existing bucket-root configuration does not introduce leading slashes in object keys", async t => {
  const f = await fixture(t, ""); await f.archive.flush();
  assert.ok(f.objects.has("article/1/latest.json"));
  assert.ok(f.objects.has("album/2/latest.json"));
  assert.ok(f.objects.has("videos/film/metadata/latest.json"));
  assert.equal([...f.objects.keys()].some(key => key.startsWith("/")), false);
});

test("deleted articles get a tombstone while the preceding Markdown snapshot remains in OSS", async t => {
  const f = await fixture(t); await f.archive.flush();
  const previous = f.latest("article").pointer.contentKey;
  const mutation = await f.archive.before({ pathname: "/items/posts/1", method: "DELETE" });
  f.data.posts = [];
  await f.archive.after(mutation); await f.archive.flush();
  assert.equal(f.latest("article").snapshot.deleted, true);
  assert.equal(f.latest("article").pointer.contentKey, null);
  assert.ok(f.objects.has(previous));
});

test("archive only collects local asset IDs and retains Markdown with missing files", async t => {
  const f = await fixture(t);
  const shared = "d310f86d-6db6-4a89-ae73-beaa1b534c13";
  const external = "621e10e7-2209-43bf-bfac-6cf7ac7c2b22";
  const missing = "fed6300b-dd85-4189-839b-af0ce0a12960";
  f.data.posts[0].cover_image = null;
  f.data.posts[0].content = `![remote](https://example.org/assets/logo.png) ![remote ID](https://example.org/api/assets/${external}) ![cover](/media/assets/${shared}.png) ![missing](/api/assets/${missing})`;
  f.data.files.push({ id: shared, storage: "oss_video", filename_disk: shared + ".png" });
  assert.equal(await f.archive.flush(), false);
  const article = f.latest("article");
  assert.deepEqual(article.snapshot.files.map(file => file.id), [shared, missing]);
  assert.equal(article.snapshot.files[0].object_key, `blog_all/videos/assets/${shared}.png`);
  assert.equal(article.snapshot.files[1].missing, true);
  assert.equal(f.objects.get(article.pointer.contentKey).bytes.toString(), f.data.posts[0].content);
});

test("deleting a video project replaces the latest pointer under its original slug", async t => {
  const f = await fixture(t); await f.archive.flush();
  const previous = f.latest("videos").pointer.metadataKey;
  const mutation = await f.archive.before({ pathname: "/items/video_projects/5", method: "DELETE" });
  f.data.video_projects = [];
  await f.archive.after(mutation); await f.archive.flush();
  assert.equal(f.latest("videos").snapshot.deleted, true);
  assert.ok(f.objects.has(previous));
  assert.equal(f.objects.has("blog_all/videos/5/metadata/latest.json"), false);
});

test("a denied collection read leaves its archive pending until access returns", async t => {
  const f = await fixture(t); await f.archive.flush(); await f.archive.close();
  const originalKey = f.latest("article").pointer.metadataKey;
  let denied = true;
  const archive = createContentArchive({ config: f.config, journalRoot: f.root, objectStore: f.objectStore,
    request: async route => {
      if (denied && route.startsWith("/files?")) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
      return f.request(route);
    } });
  try {
    await archive.init(); f.data.posts[0].content = "updated";
    assert.equal(await archive.flush(), true);
    assert.equal(f.latest("article").pointer.metadataKey, originalKey);
    denied = false;
    assert.equal(await archive.flush(), false);
    assert.equal(f.latest("article").snapshot.record.content, "updated");
  } finally { await archive.close(); }
});

test("an unwritable outbox retries a committed edit after the disk recovers", async t => {
  const f = await fixture(t); await f.archive.flush();
  f.data.posts[0].content = "saved while the outbox was unavailable";
  const backup = f.root + "-offline";
  await fs.rename(f.root, backup);
  try {
    const mutation = await f.archive.before({ pathname: "/items/posts/1", method: "PATCH" });
    await assert.rejects(f.archive.after(mutation, f.data.posts[0]), { code: "ENOENT" });
  } finally { await fs.rename(backup, f.root); }
  assert.equal((await f.archive.status()).pending, 1);
  assert.equal(await f.archive.flush(), false);
  assert.equal(f.objects.get(f.latest("article").pointer.contentKey).bytes.toString(), f.data.posts[0].content);
});

test("failed OSS snapshots remain queued across restart and do not require completed-object deletion", async t => {
  const f = await fixture(t);
  const write = f.objectStore.write;
  f.objectStore.write = async () => { throw new Error("fixture offline"); };
  assert.equal(await f.archive.flush(), true);
  assert.equal((await fs.readdir(f.root)).filter(name => name.endsWith(".json")).length, 3);
  await f.archive.close();
  f.objectStore.write = write;
  const restarted = createContentArchive({ config: f.config, journalRoot: f.root, request: f.request, objectStore: f.objectStore });
  await restarted.init();
  assert.equal(await restarted.flush(), false);
  await restarted.close();
  assert.equal(f.latest("article").snapshot.record.title, "文章");
});

test("an edit arriving during upload is not lost when the older snapshot finishes", async t => {
  const f = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const write = f.objectStore.write;
  let paused = false;
  f.objectStore.write = async item => {
    if (!paused && item.key.startsWith("blog_all/article/")) { paused = true; entered(); await gate; }
    await write(item);
  };
  const running = f.archive.flush(); await started;
  f.data.posts[0].content = "# 新正文";
  const mutation = await f.archive.before({ pathname: "/items/posts/1", method: "PATCH" });
  await f.archive.after(mutation, f.data.posts[0]);
  assert.ok((await fs.readdir(f.root)).includes("article-1.working.json"));
  assert.ok((await fs.readdir(f.root)).includes("article-1.json"));
  release(); await running;
  assert.equal(f.objects.get(f.latest("article").pointer.contentKey).bytes.toString(), "# 新正文");
  assert.deepEqual(await fs.readdir(f.root), []);
});
