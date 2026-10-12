const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const apiEnv = loadEnv(path.join(ROOT, "apps", "api", ".env"));
const API_URL = stripSlash(apiEnv.API_URL || "http://127.0.0.1:8060");
const WEB_URL = stripSlash(apiEnv.WEB_URL || "http://127.0.0.1:3000");
const DIRECTUS_URL = stripSlash(
  apiEnv.DIRECTUS_URL || "http://127.0.0.1:8055"
);
const token = String(apiEnv.UPLOAD_API_TOKEN || "").trim();
const testSlug = `album-api-test-${Date.now()}`;
const testTitle = `Album API Test ${Date.now()}`;

function loadEnv(filePath) {
  const values = { ...process.env };
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return values;
}

function stripSlash(value) {
  return String(value).replace(/\/$/, "");
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Preserve the raw response in the error below.
  }
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${url} failed: ${response.status} ${
        payload?.error || payload?.errors?.[0]?.message || text
      }`
    );
  }
  return payload;
}

function albumHeaders(json = true) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {})
  };
}

async function albumRequest(pathname, options = {}) {
  return jsonRequest(`${API_URL}${pathname}`, {
    ...options,
    headers: {
      ...albumHeaders(!(options.body instanceof FormData)),
      ...(options.headers || {})
    }
  });
}

async function directusLogin() {
  const response = await jsonRequest(`${DIRECTUS_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: apiEnv.DIRECTUS_EMAIL,
      password: apiEnv.DIRECTUS_PASSWORD
    })
  });
  return response.data.access_token;
}

async function directusRequest(pathname, directusToken, options = {}) {
  return jsonRequest(`${DIRECTUS_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${directusToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function cleanup(albumId, knownFileIds) {
  if (!albumId) return;
  const directusToken = await directusLogin();
  const fileIds = new Set(knownFileIds.filter(Boolean));

  try {
    const album = await directusRequest(
      `/items/albums/${albumId}?fields=id,photos.id,photos.sdr_image,photos.hdr_image`,
      directusToken
    );
    for (const photo of album.data.photos || []) {
      if (photo.sdr_image) fileIds.add(String(photo.sdr_image));
      if (photo.hdr_image) fileIds.add(String(photo.hdr_image));
    }
  } catch {
    // The album may already be gone after a failed test cleanup.
  }

  await directusRequest(`/items/albums/${albumId}`, directusToken, {
    method: "DELETE"
  }).catch(() => {});
  for (const fileId of fileIds) {
    await directusRequest(`/files/${encodeURIComponent(fileId)}`, directusToken, {
      method: "DELETE"
    }).catch(() => {});
  }
}

async function main() {
  assert.ok(
    token && !token.startsWith("__REPLACE_"),
    "UPLOAD_API_TOKEN must be configured before the live album API test."
  );

  let albumId = null;
  const fileIds = [];
  try {
    const created = await albumRequest("/albums", {
      method: "POST",
      body: JSON.stringify({
        title: testTitle,
        slug: testSlug,
        description: "Temporary live album API integration test.",
        published: false
      })
    });
    albumId = created.album.id;
    assert.equal(created.album.slug, testSlug);
    assert.equal(created.album.published, false);

    const draftPage = await fetch(`${WEB_URL}/albums/${testSlug}`);
    const draftPageBody = await draftPage.text();
    assert.doesNotMatch(
      draftPageBody,
      new RegExp(testTitle),
      "Draft album content was publicly visible."
    );
    assert.match(draftPageBody, /404|could not be found/i);

    const pngPath = path.join(
      ROOT,
      "apps",
      "web",
      "src",
      "app",
      "favicon.png"
    );
    const form = new FormData();
    form.append(
      "manifest",
      JSON.stringify({
        photos: [
          {
            key: "api-album-sdr.final",
            caption: "Temporary SDR integration image.",
            altText: "A temporary square test image.",
            published: true
          }
        ]
      })
    );
    form.append(
      "sdrFiles",
      new Blob([fs.readFileSync(pngPath)], { type: "image/png" }),
      "api-album-sdr.final.png"
    );
    const uploaded = await albumRequest(`/albums/${albumId}/photos`, {
      method: "POST",
      body: form
    });
    assert.equal(uploaded.photos.length, 1);
    const photo = uploaded.photos[0];
    fileIds.push(photo.sdrImage);
    assert.ok(photo.sdrImage);
    assert.equal(photo.hdrImage, null);
    const directusToken = await directusLogin();
    const storedFile = await directusRequest(
      `/files/${encodeURIComponent(photo.sdrImage)}?fields=id,description`,
      directusToken
    );
    const reconciliationTag = String(storedFile.data.description || "");
    assert.match(
      reconciliationTag,
      /^album-upload:/,
      "Album file reconciliation tag was not stored."
    );
    const tagQuery = new URLSearchParams({
      "filter[description][_eq]": reconciliationTag,
      fields: "id,description",
      limit: "2"
    });
    const taggedFiles = await directusRequest(
      `/files?${tagQuery.toString()}`,
      directusToken
    );
    assert.deepEqual(
      taggedFiles.data.map((file) => String(file.id)),
      [String(photo.sdrImage)],
      "Album file reconciliation tag was not queryable."
    );

    const thumbnail = await fetch(
      `${API_URL}/assets/${photo.sdrImage}?key=album-thumb`
    );
    assert.equal(thumbnail.status, 200);
    assert.match(
      String(thumbnail.headers.get("content-type")),
      /^image\/webp/
    );

    const arbitraryTransform = await fetch(
      `${API_URL}/assets/${photo.sdrImage}?width=12`
    );
    assert.equal(arbitraryTransform.status, 400);

    await albumRequest(`/albums/${albumId}`, {
      method: "PATCH",
      body: JSON.stringify({ published: true })
    });
    const publishedPage = await fetch(`${WEB_URL}/albums/${testSlug}`);
    assert.equal(publishedPage.status, 200);
    assert.match(await publishedPage.text(), new RegExp(testTitle));

    const managed = await albumRequest("/albums/manage");
    const managedAlbum = managed.albums.find(
      (album) => album.id === albumId
    );
    assert.ok(managedAlbum);
    assert.equal(managedAlbum.photoCount, 1);
    assert.equal(managedAlbum.coverImage, photo.sdrImage);

    await albumRequest(`/albums/${albumId}/photos/${photo.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        caption: "Updated temporary caption.",
        altText: "Updated temporary alternative text.",
        published: false
      })
    });
    const unpublished = (
      await albumRequest("/albums/manage")
    ).albums.find((album) => album.id === albumId);
    assert.equal(unpublished.photos[0].published, false);
    assert.equal(unpublished.coverImage, null);

    await albumRequest(`/albums/${albumId}/photos/${photo.id}`, {
      method: "PATCH",
      body: JSON.stringify({ published: true })
    });
    await albumRequest(`/albums/${albumId}/photos/reorder`, {
      method: "POST",
      body: JSON.stringify({ photoIds: [photo.id] })
    });
    await albumRequest(`/albums/${albumId}/cover`, {
      method: "PUT",
      body: JSON.stringify({ photoId: photo.id })
    });
    const deleted = await albumRequest(`/albums/${albumId}/photos/${photo.id}`, {
      method: "DELETE"
    });
    assert.equal(deleted.status, "ok");
    assert.equal(deleted.cleanupRequired, false);
    assert.deepEqual(deleted.orphanFileIds, []);

    const afterDelete = (
      await albumRequest("/albums/manage")
    ).albums.find((album) => album.id === albumId);
    assert.equal(afterDelete.photoCount, 0);
    assert.equal(afterDelete.coverImage, null);
    const deletedAsset = await fetch(`${API_URL}/assets/${photo.sdrImage}`);
    assert.ok(
      [403, 404].includes(deletedAsset.status),
      `deleted asset remained accessible (${deletedAsset.status})`
    );

    console.log(`album_api_album=${albumId}`);
    console.log(`album_api_photo=${photo.id}`);
    console.log("album_api_draft_filter=ok");
    console.log("album_api_preset=ok");
    console.log("album_api_crud=ok");
  } finally {
    await cleanup(albumId, fileIds);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
