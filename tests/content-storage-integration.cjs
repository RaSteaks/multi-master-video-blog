const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const fixture = await startFixture({ name: "content-storage", oss: true, cmsPort: 18069, apiPort: 18074, webPort: 13014 });
  const report = { checks: [], realOss: false, passed: false };
  const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  const headers = { Authorization: `Bearer ${fixture.token}` };
  async function request(route, options) {
    const response = await fetch(`${fixture.apiUrl}${route}`, { ...options, headers: { ...headers, ...options?.headers } });
    const body = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  async function waitForSnapshot(key, accepts = () => true) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const object = fixture.cloud.objects.get(key);
      if (object) {
        const pointer = JSON.parse(object.bytes);
        const snapshot = JSON.parse(fixture.cloud.objects.get(pointer.metadataKey).bytes);
        if (accepts(snapshot)) return { pointer, snapshot };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Snapshot not ready: ${key}`);
  }
  try {
    const png = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#438d71" } }).png().toBuffer();
    const articleForm = new FormData();
    articleForm.set("title", "OSS article"); articleForm.set("slug", "oss-article"); articleForm.set("published", "true");
    articleForm.set("content", "# OSS 正文\n\n![图片](article-image://picture)");
    articleForm.set("inlineImageManifest", JSON.stringify([{ key: "picture", name: "picture.png", alt: "图片" }]));
    articleForm.append("inlineImages", new Blob([png], { type: "image/png" }), "picture.png");
    const article = await request("/articles", { method: "POST", headers: { "X-Article-Token": fixture.token }, body: articleForm });
    const articleFile = fixture.collections.files.find(file => file.id === article.uploadedImages[0].id);
    assert.equal(articleFile.storage, "oss_article");
    assert.deepEqual(fixture.cloud.objects.get(`blog_all/article/assets/${articleFile.filename_disk}`).bytes, png);
    const archivedArticle = await waitForSnapshot(`blog_all/article/${article.article.id}/latest.json`);
    assert.match(fixture.cloud.objects.get(archivedArticle.pointer.contentKey).bytes.toString(), /# OSS 正文/);
    assert.equal(archivedArticle.snapshot.files[0].object_key, `blog_all/article/assets/${articleFile.filename_disk}`);
    pass("article API routes images under article/assets and archives Markdown with restorable file metadata");

    // A saved article keeps its ID even if disk admission to the outbox fails.
    const journal = path.join(fixture.temp, "content-archive");
    const unavailable = journal + "-offline";
    let pendingArticle;
    await fs.rename(journal, unavailable);
    try {
      const form = new FormData();
      form.set("title", "Pending archive"); form.set("slug", "pending-archive");
      form.set("content", "![remote](https://example.invalid/assets/logo.png)");
      const response = await fetch(fixture.apiUrl + "/articles", { method: "POST",
        headers: { "X-Article-Token": fixture.token }, body: form });
      assert.equal(response.status, 202);
      pendingArticle = await response.json();
      assert.equal(pendingArticle.status, "partial");
      assert.equal(pendingArticle.archivePending, true);
      assert.equal(fixture.collections.posts.find(row => row.slug === "pending-archive").id, pendingArticle.article.id);
    } finally { await fs.rename(unavailable, journal); }
    const album = await request("/albums", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "OSS album", slug: "oss-album", published: true }) });
    await waitForSnapshot(`blog_all/article/${pendingArticle.article.id}/latest.json`);
    pass("a confirmed save reports its pending archive and retries after the outbox is writable");
    const photoForm = new FormData();
    photoForm.set("manifest", JSON.stringify({ photos: [{ key: "photo", caption: "OSS 相片", published: true }] }));
    photoForm.append("sdrFiles", new Blob([png], { type: "image/png" }), "photo.png");
    const photos = await request(`/albums/${album.album.id}/photos`, { method: "POST", body: photoForm });
    const photoId = photos.photos[0].sdrImage;
    const photoFile = fixture.collections.files.find(file => file.id === photoId);
    assert.equal(photoFile.storage, "oss_album");
    assert.deepEqual(fixture.cloud.objects.get(`blog_all/album/assets/${photoFile.filename_disk}`).bytes, png);
    await waitForSnapshot(`blog_all/album/${album.album.id}/latest.json`, snapshot => snapshot.photos?.length === 1);
    pass("album API routes photos under album/assets and archives the album description/order/photo references");

    const videoPath = path.join(fixture.temp, "input.mp4");
    await promisify(execFile)(process.env.FFMPEG_PATH || require("ffmpeg-static"), ["-v", "error", "-f", "lavfi", "-i",
      "testsrc2=size=160x96:rate=10:duration=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", "-color_primaries", "bt709",
      "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-chroma_sample_location", "left", videoPath]);
    const videoBytes = await fs.readFile(videoPath);
    const videoForm = new FormData();
    for (const [key, value] of Object.entries({ title: "OSS video", slug: "oss-video", masterType: "sdr", mode: "copy", published: "true" })) videoForm.set(key, value);
    videoForm.append("video", new Blob([videoBytes], { type: "video/mp4" }), "video.mp4");
    videoForm.append("cover", new Blob([png], { type: "image/png" }), "cover.png");
    const video = await request("/uploads/videos", { method: "POST", body: videoForm });
    assert.equal(video.storage, "oss");
    assert.ok(fixture.cloud.objects.has(`blog_all/videos/${video.hlsUrl.slice("/media/".length)}`));
    const cover = fixture.collections.files.find(file => file.id === video.project.cover_image);
    assert.equal(cover.storage, "oss_video");
    assert.ok(fixture.cloud.objects.has(`blog_all/videos/assets/${cover.filename_disk}`));
    await waitForSnapshot("blog_all/videos/oss-video/metadata/latest.json", snapshot => snapshot.masters?.length === 1);
    await assert.rejects(fs.access(path.join(fixture.temp, video.sourceUrl.replace("/media/", "media/"))), { code: "ENOENT" });
    const stream = await fetch(`${fixture.apiUrl}${video.sourceUrl}`, { headers: { ...headers, Range: "bytes=0-15" } });
    assert.equal(stream.status, 206); assert.deepEqual(Buffer.from(await stream.arrayBuffer()), videoBytes.subarray(0, 16));
    pass("video API processes locally, archives source/HLS/cover/metadata under videos and streams ranges after local eviction");
    assert.deepEqual(fixture.cloud.errors, []);
    assert.equal(fixture.cloud.calls.some(call => call.method === "DELETE" && !call.multipart), false);
    report.passed = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    report.objectKeys = [...fixture.cloud.objects.keys()].sort();
    await fs.writeFile(path.join(fixture.output, "report.json"), JSON.stringify(report, null, 2));
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
