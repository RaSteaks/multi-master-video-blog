const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeProject, createExternalProjects } = require("../src/external-projects.cjs");
const { canReadAsset } = require("../src/asset-access.cjs");

test("website metadata is bounded, typed and never promotes arbitrary CMS files", () => {
  const result = normalizeProject({ title: " 黑洞 ", url: "https://example.com", published: "true", preview_enabled: "false", sort_order: "-2" });
  assert.equal(result.title, "黑洞"); assert.equal(result.url, "https://example.com/");
  assert.equal(result.published, true); assert.equal(result.preview_enabled, false); assert.equal(result.sort_order, -2);
  for (const input of [null, [], { title: "", url: "https://example.com" }, { title: "x", url: "javascript:alert(1)" },
    { title: "x", url: "https://user:password@example.com" }, { title: "x", url: "http://example.com" },
    { published: "yes" }, { sort_order: 1.5 }, { cover_image: "private-file-id" }, { description: "x".repeat(301) }]) {
    assert.throws(() => normalizeProject(input), error => error.statusCode === 400);
  }
  assert.equal(normalizeProject({ url: "http://127.0.0.1:18080" }, { partial: true, allowLocal: true }).url, "http://127.0.0.1:18080/");
  assert.throws(() => normalizeProject({ url: "http://127.0.0.1:18080" }, { partial: true }), /HTTPS/);
  assert.deepEqual(normalizeProject({ published: false }, { partial: true }), { published: false });
  assert.deepEqual(normalizeProject({ group_name: " 光与颜色 " }, { partial: true }), { group_name: "光与颜色" });
  assert.throws(() => normalizeProject({ group_name: "x".repeat(61) }, { partial: true }), /60/);
  assert.throws(() => normalizeProject({ group_name: null }, { partial: true }), /60/);
});

test("layout writes only the singleton's layout, validates choices and confirms persistence", async () => {
  let settings = { accent_color: "#123456", project_layout: null };
  const writes = [];
  const store = createExternalProjects({ request: async (route, options) => {
    assert.equal(route, "/items/site_settings?fields=project_layout");
    if (options) { writes.push(options); settings = { ...settings, ...options.body }; }
    return { data: settings };
  } });
  assert.deepEqual(await store.getLayout(), { layout: "grid" });
  for (const layout of ["catalogue", "mosaic", "alternating", "masonry", "groups", "dual", "grid"]) {
    assert.deepEqual(await store.saveLayout({ layout }), { layout });
    assert.deepEqual(await store.getLayout(), { layout });
  }
  assert.equal(settings.accent_color, "#123456");
  assert.deepEqual(writes[0], { method: "PATCH", body: { project_layout: "catalogue" } });
  for (const input of [null, [], {}, { layout: "unknown" }, { layout: "grid", accent_color: "red" }]) {
    await assert.rejects(store.saveLayout(input), error => error.statusCode === 400);
  }
  assert.equal(writes.length, 7);
  const unconfirmed = createExternalProjects({ request: async () => ({ data: null }) });
  await assert.rejects(unconfirmed.saveLayout({ layout: "dual" }), error => error.statusCode === 502);
});

test("listing an unmigrated CMS drops only the new group field and keeps publication filters", async () => {
  const calls = [];
  const store = createExternalProjects({ request: async route => {
    const url = new URL(route, "https://cms.invalid"); calls.push(url);
    if (calls.length === 1) throw Object.assign(new Error("field missing"), { directusHttpStatus: 403 });
    return { data: [] };
  } });
  await store.list({ page: 2 });
  assert.equal(calls[1].searchParams.get("fields").includes("group_name"), false);
  assert.equal(calls[1].searchParams.get("filter[published][_eq]"), "true");
  assert.equal(calls[1].searchParams.get("offset"), "24");
});

test("public listing filters publication and uses bounded pages; management is separate", async () => {
  const routes = [];
  const store = createExternalProjects({ request: async route => { routes.push(new URL(route, "https://cms.invalid")); return { data: Array.from({ length: 25 }, (_, i) => ({ id: i + 1 })) }; } });
  const result = await store.list({ page: 2 });
  assert.equal(result.projects.length, 24); assert.equal(result.hasMore, true);
  assert.equal(routes[0].searchParams.get("filter[published][_eq]"), "true");
  assert.equal(routes[0].searchParams.get("offset"), "24");
  await store.list({ managed: true });
  assert.equal(routes[1].searchParams.has("filter[published][_eq]"), false);
  await assert.rejects(store.list({ page: -1 }), error => error.statusCode === 400);
});

test("create/update associate validated covers; rejected writes remove only the new upload", async () => {
  const writes = []; const removed = [];
  let reject = false;
  const store = createExternalProjects({
    request: async (route, options) => {
      if (!options) return { data: { id: 1 } };
      if (reject) throw Object.assign(new Error("rejected"), { directusHttpStatus: 400 });
      writes.push({ route, ...options }); return { data: { id: 1, ...options.body } };
    }, uploadCover: async () => "new-cover", removeUploadedCover: async id => removed.push(id),
  });
  const created = await store.save(null, { title: "黑洞", url: "https://example.com" }, { cover: {} });
  assert.equal(created.cover_image, "new-cover"); assert.equal(created.published, false);
  assert.equal(writes[0].method, "POST");
  await store.save(1, { published: true });
  assert.equal(writes[1].method, "PATCH"); assert.equal("cover_image" in writes[1].body, false);
  reject = true;
  await assert.rejects(store.save(1, { title: "修改" }, { cover: {} }), /rejected/);
  assert.deepEqual(removed, ["new-cover"]);
  await assert.rejects(store.save(1, {}, { cover: {}, removeCover: true }), /同时/);
});

test("uncertain writes retain the uploaded cover for reconciliation", async () => {
  const removed = [];
  const store = createExternalProjects({ request: async () => { throw Object.assign(new Error("uncertain"), { directusAmbiguous: true }); },
    uploadCover: async () => "new-cover", removeUploadedCover: async id => removed.push(id) });
  await assert.rejects(store.save(null, { title: "黑洞", url: "https://example.com" }, { cover: {} }), /uncertain/);
  assert.deepEqual(removed, []);
});

test("website cover access follows publication and author scope, including revocation", async () => {
  let published = false;
  const request = async route => {
    const url = new URL(route, "https://cms.invalid");
    if (url.pathname !== "/items/external_projects") return { data: [] };
    const filter = JSON.parse(url.searchParams.get("filter"));
    return { data: filter.cover_image._eq === "cover" && (!filter.published || published) ? [{ id: 1 }] : [] };
  };
  assert.equal(await canReadAsset("cover", {}, request), false);
  assert.equal(await canReadAsset("cover", { media: true }, request), true);
  assert.equal(await canReadAsset("cover", { article: true }, request), false);
  published = true; assert.equal(await canReadAsset("cover", {}, request), true);
  published = false; assert.equal(await canReadAsset("cover", {}, request), false);
});
