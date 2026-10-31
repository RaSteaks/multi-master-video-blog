const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(albums) {
  // Exercise the actual management query and serializers without starting a CMS or uploading files.
  const source = fs.readFileSync(path.join(__dirname, "../src/server.cjs"), "utf8");
  const names = ["parseBoolean", "directusFileId", "directusRelationId", "serializeManagedPhoto",
    "serializeManagedAlbum", "handleAlbumManageGet", "listAlbumPhotos"];
  const declarations = names.map((name) => {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  });
  for (const name of ["ALBUM_ITEM_FIELDS", "ALBUM_PHOTO_FIELDS"]) {
    const match = source.match(new RegExp("^const " + name + " = \\[[\\s\\S]*?^\\]\\.join\\(\",\"\\);", "m"));
    assert.ok(match, name);
    declarations.unshift(match[0]);
  }
  let response;
  const api = vm.createContext({
    URLSearchParams,
    directusLogin: async () => "test-token",
    getAlbumById: async () => ({ ...albums[0], photos: undefined }),
    directusRequest: async (pathname) => {
      const fields = new URL(pathname, "http://localhost").searchParams.get("fields").split(",");
      for (const field of ["sdr_image.id", "sdr_image.width", "sdr_image.height"]) {
        assert.ok(fields.includes(field), `Missing management file field: ${field}`);
      }
      return { data: albums[0]?.photos || [] };
    },
    sendJson: (res, status, body) => { response = { status, body }; }
  });
  vm.runInContext(declarations.join("\n"), api);
  return { api, response: () => response };
}

test("management preserves portrait dimensions and file IDs for published and draft photos", async () => {
  const { api, response } = fixture([{
    id: 1,
    published: true,
    photos: [
      { id: 2, sdr_image: { id: "landscape", width: 4000, height: 3000 }, published: false, sort_order: 1 },
      { id: 1, sdr_image: { id: "portrait", width: 2220, height: 3106 }, published: true, sort_order: 0 }
    ]
  }]);
  await api.handleAlbumManageGet({}, 1);
  const result = response();
  assert.equal(result.status, 200);
  const photos = result.body.album.photos;
  assert.deepEqual(Array.from(photos, (photo) => [photo.sdrImage, photo.width, photo.height, photo.published]), [
    ["portrait", 2220, 3106, true],
    ["landscape", 4000, 3000, false]
  ]);
});

test("mutation responses with unexpanded or unknown SDR geometry keep nullable dimensions", () => {
  const { api } = fixture([]);
  for (const file of ["new-upload", { id: "missing-height", width: 4000 }, { id: "empty", width: 0, height: 3000 }]) {
    const photo = api.serializeManagedPhoto({ id: 1, sdr_image: file, published: true });
    assert.equal(photo.sdrImage, typeof file === "string" ? file : file.id);
    assert.equal(photo.width, null);
    assert.equal(photo.height, null);
  }
});
