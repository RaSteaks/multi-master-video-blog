const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { Readable, Writable, PassThrough } = require("node:stream");
const { finished, pipeline } = require("node:stream/promises");
const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "apps/api/src/server.cjs"), "utf8");
const media = require("../apps/api/src/media-security.cjs");
const { canReadAsset } = require("../apps/api/src/asset-access.cjs");
const { createCachedProbe } = require("../apps/api/src/cached-probe.cjs");
const { createDirectusClient } = require("../apps/api/src/directus-client.cjs");

// Exercise real request handlers with isolated storage and fake CMS/process effects.
// No server listener, publishing credential, database or production media is used.
function apiFixture(names, extra = {}) {
  const context = vm.createContext({ fs, fsp, path, crypto, Buffer, URL, URLSearchParams,
    // Stream aborts and resource diagnostics are part of the combined API runtime.
    Readable, Response, AbortController, AbortSignal, pipeline, MAX_LEGACY_UPLOAD_BYTES: 8 * 1024 ** 3,
    // Isolate admission from the separately tested ownership/stream policies.
    assetSlots: { acquire: async () => () => {} }, assetBudget: { consume() {} },
    requestAddress: () => "fixture", TRUST_PROXY: false,
    assetAccess: () => ({}), canReadMedia: async () => true, PUBLIC_MEDIA_FILES: new Set(), ...media, ...require("../apps/api/src/http-utils.cjs"), ...extra });
  context.authorizeAsset = async (id, access) => (extra.canReadAsset || canReadAsset)(id, access,
    route => context.directusRequest(route, "service-token"), context.PUBLIC_ASSET_IDS);
  vm.runInContext(names.map(name => {
    const match = apiSource.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n"), context);
  return context;
}
class Reply extends Writable {
  constructor() { super(); this.status = 0; this.headers = {}; this.chunks = []; }
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }
  _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  text() { return Buffer.concat(this.chunks).toString(); }
}
async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blog-security-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function write(filename, data = "private") {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(filename, data);
}

function loadTs(filename, dependencies = {}, globals = {}) {
  const ts = require("typescript"), module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, URL, URLSearchParams,
    Response, Request, AbortSignal, AbortController, ...globals,
    require: name => dependencies[name] || (name.endsWith(".ts")
      ? loadTs(path.resolve(path.dirname(filename), name), dependencies, globals) : createRequire(filename)(name)),
  });
  return module.exports;
}

test("all legacy scan files migrate without changing persisted Windows/POSIX paths", async t => {
  const dir = await temp(t), publicRoot = path.join(dir, "media"), privateRoot = path.join(dir, "private/scans");
  await write(path.join(publicRoot, "film-scans/1/sources/previews/7.jpg"));
  await write(path.join(publicRoot, "film-scans/2/rollback.json"), "{\"files\":[\"retained\"]}");
  await media.prepareFilmScanStorage(publicRoot, privateRoot);
  const image = media.filmScanPath(privateRoot, "film-scans\\1\\sources\\previews\\7.jpg");
  assert.equal(await fsp.readFile(image, "utf8"), "private");
  assert.equal(media.filmScanStoredPath(privateRoot, path.join(path.dirname(image), "8.jpg")), "film-scans/1/sources/previews/8.jpg");
  assert.equal(JSON.parse(await fsp.readFile(path.join(privateRoot, "2/rollback.json"))).files[0], "retained");
  await assert.rejects(fsp.access(path.join(publicRoot, "film-scans")), { code: "ENOENT" });
  await media.prepareFilmScanStorage(publicRoot, privateRoot); // Restart is idempotent.
  for (const unsafe of ["../secret", "film-scans/../secret", "film-scans/C:/secret", "/film-scans/1", "film-scans\\..\\secret"]) {
    assert.throws(() => media.filmScanPath(privateRoot, unsafe));
  }
});

test("migration conflicts and public/symlink private roots fail without overwriting", async t => {
  const dir = await temp(t), pub = path.join(dir, "media"), priv = path.join(dir, "private");
  await write(path.join(pub, "film-scans/1/rollback.json"), "old");
  await write(path.join(priv, "1/rollback.json"), "new");
  await assert.rejects(media.prepareFilmScanStorage(pub, priv), /conflict/);
  assert.equal(await fsp.readFile(path.join(pub, "film-scans/1/rollback.json"), "utf8"), "old");
  assert.equal(await fsp.readFile(path.join(priv, "1/rollback.json"), "utf8"), "new");
  await assert.rejects(media.prepareFilmScanStorage(pub, path.join(pub, "private")), /outside/);
  await fsp.symlink(pub, path.join(dir, "linked"), "dir");
  await assert.rejects(media.prepareFilmScanStorage(pub, path.join(dir, "linked/private")), /resolve into/);
});

test("legacy film-scans video projects retain HLS URLs while numeric jobs move", async t => {
  const dir = await temp(t), pub = path.join(dir, "media"), priv = path.join(dir, "private");
  await write(path.join(pub, "film-scans/1/sources/review.jpg"), "private");
  await write(path.join(pub, "film-scans/sdr/v1/index.m3u8"), "#EXTM3U");
  await write(path.join(pub, "film-scans/source/video.mp4"), "video");
  await media.prepareFilmScanStorage(pub, priv);
  const playlist = await media.publicMediaPath(pub, priv, "film-scans/sdr/v1/index.m3u8");
  assert.equal(await fsp.readFile(playlist, "utf8"), "#EXTM3U");
  assert.equal(await fsp.readFile(path.join(pub, "film-scans/source/video.mp4"), "utf8"), "video");
  await assert.rejects(media.publicMediaPath(pub, priv, "film-scans/1/sources/review.jpg"), { statusCode: 404 });
});

test("media paths block private names, encodings and symlinks while public range reads work", async t => {
  const dir = await temp(t), pub = path.join(dir, "media"), priv = path.join(dir, "private");
  await write(path.join(pub, "video/movie.mp4"), "0123456789");
  await write(path.join(priv, "1/secret.jpg"));
  await fsp.symlink(path.join(priv, "1/secret.jpg"), path.join(pub, "alias.jpg"));
  for (const name of ["film-scans/1/secret.jpg", "FILM-SCANS/1/secret.jpg", "film-scans%2f1/secret.jpg",
    "film-scans%5c1%5csecret.jpg", "film-scans./1", "film-scans%20/1", "film-scans::$INDEX_ALLOCATION/1", "../private/1/secret.jpg", "alias.jpg"]) {
    await assert.rejects(media.publicMediaPath(pub, priv, name), { statusCode: 404 }, name);
  }
  const api = apiFixture(["handleMedia", "contentType", "cacheControl", "httpError", "sendJson"], {
    MEDIA_ROOT: pub, FILM_SCAN_ROOT: priv, JSON_COMPRESSION_MIN_BYTES: Infinity
  });
  const res = new Reply();
  await api.handleMedia({ method: "GET", headers: { range: "bytes=2-5" } }, "/media/video/movie.mp4", res);
  await finished(res);
  assert.equal(res.status, 206); assert.equal(res.text(), "2345");
  assert.equal(res.headers["Content-Range"], "bytes 2-5/10");
  const denied = new Reply();
  await api.handleMedia({ method: "HEAD", headers: {} }, "/media/film-scans/1/secret.jpg", denied);
  assert.equal(denied.status, 404);
  const nginx = fs.readFileSync(path.join(root, "deployment/nginx/windows-nginx.example.conf"), "utf8");
  assert.doesNotMatch(nginx, /\balias\s/); // No independent static outlet can bypass Node.
  assert.match(nginx, /location \/media\/\s*\{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:8060;/);
});

// Generic subset of Directus filter semantics for fixture data, not a second asset policy.
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "_or") return value.some(item => matches(row, item));
    if (key === "_eq") return row === value;
    if (key === "_contains") return typeof row === "string" && row.includes(value);
    return matches(row?.[key], value);
  });
}
function cms(data) {
  return async route => {
    const url = new URL(route, "http://fixture.invalid"), collection = url.pathname.split("/").at(-1);
    if (url.pathname.startsWith("/files/")) return { data: data.files?.[collection] || null };
    if (collection === "site_settings") return { data: data.site_settings || {} };
    const rows = (data[collection] || []).filter(row => matches(row, JSON.parse(url.searchParams.get("filter"))));
    const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
    return { data: rows.slice(offset, offset + limit) };
  };
}

test("public asset authorization covers actual owners and revokes unpublished parents", async () => {
  const published = { published: true }, draft = { published: false };
  const data = {
    files: Object.fromEntries(["inline", "draft-inline"].map(id => [id, { description: `article-image:${crypto.randomUUID()}` }])),
    site_settings: { background_image: "background", background_images: [{ directus_files_id: "gallery" }] },
    posts: [{ ...published, cover_image: "post-cover", backgroundimage: "post-background", content: "![x](/api/assets/inline?key=content-card)" },
      { ...draft, cover_image: "draft-post", content: "![x](/api/assets/draft-inline)" },
      { ...published, content: "![x](/api/assets/prefix-longer)" }],
    video_projects: [{ ...published, cover_image: "video" }, { ...draft, cover_image: "draft-video" }],
    albums: [{ ...published, cover_image: "album" }],
    album_photos: [{ ...published, album_id: published, sdr_image: "sdr", hdr_image: "hdr" },
      { ...draft, album_id: published, sdr_image: "draft-photo" }, { ...published, album_id: draft, sdr_image: "draft-album" }],
    album_photo_renditions: [{ photo_id: { ...published, album_id: published }, file: "hlg" },
      { photo_id: { ...published, album_id: draft }, file: "draft-hlg" }]
  };
  for (const id of ["background", "gallery", "post-cover", "post-background", "inline", "video", "album", "sdr", "hdr", "hlg"]) {
    assert.equal(await canReadAsset(id, {}, cms(data)), true, id);
  }
  for (const id of ["unknown", "prefix", "draft-post", "draft-inline", "draft-video", "draft-photo", "draft-album", "draft-hlg"]) {
    assert.equal(await canReadAsset(id, {}, cms(data)), false, id);
  }
  assert.equal(await canReadAsset("draft-post", { article: true }, cms(data)), true);
  assert.equal(await canReadAsset("draft-inline", { article: true }, cms(data)), true);
  assert.equal(await canReadAsset("draft-hlg", { media: true }, cms(data)), true);
  assert.equal(await canReadAsset("draft-video", { media: true }, cms(data)), true);
  assert.equal(await canReadAsset("draft-post", { media: true }, cms(data)), false);
  assert.equal(await canReadAsset("unknown", { article: true, media: true }, cms(data)), false);
  published.published = false;
  assert.equal(await canReadAsset("sdr", {}, cms(data)), false);
  assert.equal(await canReadAsset("hlg", {}, cms(data)), false);
});

test("asset lookup handles restricted collections, outages and later exact Markdown matches", async () => {
  assert.equal(await canReadAsset("avatar", {}, cms({}), new Set(["avatar"])), true);
  assert.equal(await canReadAsset("avatar", {}, cms({})), false);
  const data = { files: { image: { description: `article-image:${crypto.randomUUID()}` } },
    posts: [...Array.from({ length: 100 }, () => ({ published: true, content: "/api/assets/image-suffix" })),
    { published: true, content: "![x](/api/assets/image)" }] };
  assert.equal(await canReadAsset("image", {}, cms(data)), true);
  const restricted = async route => {
    if (route.includes("site_settings")) throw { directusHttpStatus: 403 };
    return cms(data)(route);
  };
  assert.equal(await canReadAsset("image", {}, restricted), true);
  await assert.rejects(canReadAsset("image", {}, async () => { throw new Error("offline"); }), /offline/);
});

test("a forged article reference cannot grant access to unrelated or private album files", async () => {
  const data = { posts: [], files: { unrelated: { description: "album-upload:synthetic" } } };
  assert.equal(await canReadAsset("unrelated", { article: true }, cms(data)), false);
  data.posts.push({ published: false, content: "![x](/api/assets/unrelated)" });
  assert.equal(await canReadAsset("unrelated", { article: true }, cms(data)), false);
  data.posts[0].published = true;
  assert.equal(await canReadAsset("unrelated", {}, cms(data)), false);
  assert.equal(await canReadAsset("unrelated", { preview: true }, cms(data)), false);
});

test("article creation stamps inline uploads with service-controlled provenance", async () => {
  let uploadOptions;
  const api = apiFixture(["handleArticleCreate", "parseBoolean", "httpError", "sendJson"], {
    requireArticleAuth() {}, parseArticleMultipart: async () => ({}),
    normalizeArticleUpload: () => ({ title: "Title", slug: "title", content: "image", published: false,
      inlineImages: [{ key: "a", file: {}, name: "inline.jpg", alt: "Image" }] }),
    directusLogin: async () => "service", findPostBySlug: async () => null,
    directusFileId: value => value || null,
    directusUploadFile: async (token, file, title, options) => { uploadOptions = options; return "inline"; },
    replaceInlineImagePlaceholders: () => "![x](/api/assets/inline)",
    directusRequest: async (route, token, options) => ({ data: { id: 1, ...options.body } }),
    JSON_COMPRESSION_MIN_BYTES: Infinity,
  });
  const res = new Reply(); await api.handleArticleCreate({}, res);
  assert.equal(res.status, 201, res.text());
  assert.match(uploadOptions.reconciliationTag, /^article-image:[0-9a-f-]{36}$/);
});

test("replacing or removing a cover preserves its authorized reuse in article Markdown", async () => {
  const data = { posts: [], files: {} };
  let submitted, sequence = 0;
  const api = apiFixture(["handleArticleCreate", "parseBoolean", "httpError", "sendJson"], {
    requireArticleAuth() {}, parseArticleMultipart: async () => ({}),
    normalizeArticleUpload: () => submitted, directusLogin: async () => "service",
    getPostById: async () => data.posts[0], findPostBySlug: async () => data.posts[0],
    directusFileId: value => value || null, replaceInlineImagePlaceholders: content => content,
    directusUploadFile: async (token, file, title, options) => {
      const id = `cover-${++sequence}`;
      data.files[id] = { description: options?.reconciliationTag || null };
      return id;
    },
    directusRequest: async (route, token, options) => ({ data: data.posts[0] = { id: 1, ...options.body } }),
    JSON_COMPRESSION_MIN_BYTES: Infinity,
  });
  async function save(overrides) {
    submitted = { title: "Title", slug: "title", published: true, inlineImages: [], ...overrides };
    const res = new Reply(); await api.handleArticleCreate({}, res);
    assert.equal(res.status, submitted.articleId ? 200 : 201, res.text());
    return res;
  }
  await save({ cover: {}, content: "Article" });
  const first = data.posts[0].cover_image;
  assert.equal(await canReadAsset(first, {}, cms(data)), true);
  await save({ articleId: 1, cover: {}, content: `![retained cover](/api/assets/${first})` });
  const second = data.posts[0].cover_image;
  assert.equal(await canReadAsset(first, {}, cms(data)), true);
  await save({ articleId: 1, removeCover: true, content: `![first](/api/assets/${first}) ![second](/api/assets/${second})` });
  for (const id of [first, second]) {
    assert.equal(await canReadAsset(id, {}, cms(data)), true);
    assert.equal(await canReadAsset(id, { article: true }, cms(data)), true);
  }
  assert.notEqual(data.files[first].description, data.files[second].description);
  data.posts[0].published = false;
  assert.equal(await canReadAsset(first, {}, cms(data)), false);
  assert.equal(await canReadAsset(first, { article: true }, cms(data)), true);
  assert.equal(await canReadAsset(first, { media: true }, cms(data)), false);
});

// Run the component's actual effects with controlled visibility/network completion.
// This keeps regression tests independent of a browser, CMS, or new DOM dependencies.
function assetImageFixture({ observerAvailable = true, author = { author: false } } = {}) {
  const hooks = [], pendingEffects = [], observers = [], requests = [], revoked = [];
  const node = {};
  let cursor = 0, dirty = false, props, view, nextBlob = 0;
  const changed = (before, after) => !before || before.some((value, i) => !Object.is(value, after[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      const hook = hooks[index] ||= { value: initial };
      return [hook.value, value => {
        const next = typeof value === "function" ? value(hook.value) : value;
        if (!Object.is(next, hook.value)) { hook.value = next; dirty = true; }
      }];
    },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useMemo(create, dependencies) {
      const index = cursor++;
      if (changed(hooks[index]?.dependencies, dependencies)) hooks[index] = { value: create(), dependencies };
      return hooks[index].value;
    },
    useEffect(create, dependencies) {
      const index = cursor++;
      if (changed(hooks[index]?.dependencies, dependencies)) {
        pendingEffects.push(() => {
          hooks[index]?.cleanup?.();
          hooks[index] = { dependencies, cleanup: create() };
        });
      }
    },
  };
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    emit(isIntersecting) { this.callback([{ target: this.target, isIntersecting }]); }
  }
  const { AuthenticatedAssetImage } = loadTs(path.join(root, "apps/web/src/components/AuthenticatedAssetImage.tsx"), {
    react, "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    "@/lib/author-session": { useAuthorSession: () => author },
    "@/lib/asset-preview": {
      isAssetPreviewUrl: src => typeof src === "string" && src.startsWith("/api/assets/"),
      fetchAssetPreview: (src, token, signal) => new Promise((resolve, reject) => requests.push({ src, token, signal, resolve, reject })),
    },
  }, {
    IntersectionObserver: observerAvailable ? Observer : undefined,
    URL: { createObjectURL: () => `blob:fixture-${++nextBlob}`, revokeObjectURL: url => revoked.push(url) },
  });
  function render(next = props) {
    props = next;
    do {
      cursor = 0; dirty = false;
      view = AuthenticatedAssetImage(props);
      if (view.props.ref) view.props.ref.current = node;
      pendingEffects.splice(0).forEach(commit => commit());
    } while (dirty);
    return view;
  }
  return { render, observers, requests, revoked,
    async flush() { await Promise.resolve(); await Promise.resolve(); return render(); },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}

test("authenticated lazy images fetch only once visible and retain loaded blobs across loading changes", async () => {
  const image = assetImageFixture();
  const props = { token: "article", src: "/api/assets/photo", loading: "lazy", width: 640, height: 480 };
  const pending = image.render(props);
  assert.equal(pending.props.loading, "lazy"); assert.equal(pending.props.width, 640);
  assert.equal(image.requests.length, 0);
  image.observers[0].emit(false); image.render();
  assert.equal(image.requests.length, 0);
  image.observers[0].emit(true); image.render();
  assert.equal(image.requests.length, 1);
  assert.equal(image.observers[0].disconnected, true);
  image.observers[0].emit(true); image.render();
  assert.equal(image.requests.length, 1);
  image.requests[0].resolve({});
  assert.equal((await image.flush()).props.src, "blob:fixture-1");
  image.render({ ...props, loading: "eager" }); image.render(props);
  assert.equal(image.requests.length, 1); assert.equal(image.revoked.length, 0);
  image.unmount(); assert.deepEqual(image.revoked, ["blob:fixture-1"]);
});

test("eager/lightbox images and browsers without observers load immediately; public images stay native", () => {
  for (const loading of [undefined, "eager"]) {
    const image = assetImageFixture();
    image.render({ token: "article", src: "/api/assets/photo", loading });
    assert.equal(image.requests.length, 1); assert.equal(image.observers.length, 0);
    image.unmount(); assert.equal(image.requests[0].signal.aborted, true);
  }
  const fallback = assetImageFixture({ observerAvailable: false });
  fallback.render({ token: "article", src: "/api/assets/photo", loading: "lazy" });
  assert.equal(fallback.requests.length, 1); fallback.unmount();
  const publicImage = assetImageFixture();
  const view = publicImage.render({ src: "/api/assets/public", srcSet: "/api/assets/public 640w", loading: "lazy" });
  assert.equal(publicImage.requests.length, 0); assert.equal(publicImage.observers.length, 0);
  assert.equal(view.props.srcSet, "/api/assets/public 640w"); assert.equal(view.props.loading, "lazy");
  publicImage.unmount();
});

test("lazy image changes cancel observers and stale requests without revealing old blobs", async () => {
  const image = assetImageFixture();
  const props = { token: "first", src: "/api/assets/photo", loading: "lazy" };
  image.render(props);
  const oldObserver = image.observers[0];
  image.render({ ...props, token: "second" });
  oldObserver.emit(true); image.render(); assert.equal(image.requests.length, 0);
  image.observers[1].emit(true); image.render();
  const oldRequest = image.requests[0];
  image.render({ ...props, src: "/api/assets/new" });
  assert.equal(oldRequest.signal.aborted, true);
  oldRequest.resolve({});
  assert.equal((await image.flush()).props.src, undefined);
  const lastObserver = image.observers.at(-1);
  image.unmount();
  lastObserver.emit(true); // Already queued observer callbacks must remain inert after cleanup.
  assert.equal(image.requests.length, 1); assert.equal(image.revoked.length, 0);
});

test("asset handler checks authorization before bytes/304 and isolates old active content", async () => {
  const data = { posts: [{ published: false, cover_image: "draft" }, { published: true, cover_image: "public" }] };
  let fetches = 0, type = "image/jpeg";
  const client = createDirectusClient({
    url: "http://cms.invalid",
    fetch: async () => { fetches++; return new Response("bytes", { headers: { "content-type": type, etag: '"same"' } }); }
  });
  const api = apiFixture(["handleAsset", "assetAccess", "tokenMatches", "httpError", "sendJson"], {
    UPLOAD_API_TOKEN: "upload-token", ARTICLE_API_TOKEN: "article-token", DIRECTUS_URL: "http://cms.invalid",
    ASSET_PRESETS: new Set(["album-thumb"]), PUBLIC_ASSET_IDS: new Set(), canReadAsset, directusLogin: async () => "service-token",
    directusRequest: cms(data), JSON_COMPRESSION_MIN_BYTES: Infinity,
    fetchDirectusAsset: client.fetchDirectusAsset
  });
  async function get(id, headers = {}, method = "GET") {
    const res = new Reply();
    await api.handleAsset({ method, headers }, new URL(`http://site.invalid/assets/${id}`), res);
    await finished(res); return res;
  }
  assert.equal((await get("draft", { "if-none-match": '"same"' })).status, 404);
  assert.equal(fetches, 0);
  assert.equal((await get("public", { authorization: "Bearer invalid" })).status, 401);
  const draft = await get("draft", { authorization: "Bearer article-token" });
  assert.equal(draft.status, 200); assert.equal(draft.text(), "bytes");
  assert.equal(draft.headers["Cache-Control"], "private, no-store");
  assert.equal((await get("draft", { authorization: "Bearer upload-token" })).status, 404);
  const publicImage = await get("public");
  assert.equal(publicImage.status, 200); assert.match(publicImage.headers["Cache-Control"], /no-cache/);
  assert.equal(publicImage.headers["Content-Disposition"], "inline");
  assert.equal((await get("public", { "if-none-match": '"same"' })).status, 304);
  type = "text/html";
  const html = await get("public");
  assert.equal(html.headers["Content-Disposition"], "attachment");
  assert.match(html.headers["Content-Security-Policy"], /sandbox/);
  assert.equal(html.headers["X-Content-Type-Options"], "nosniff");
  assert.equal((await get("public", {}, "HEAD")).text(), "");
  data.posts[1].published = false;
  assert.equal((await get("public", { "if-none-match": '"same"' })).status, 404);
});

test("video cover parsing rejects active or forged files and preserves valid image bytes", async t => {
  const dir = await temp(t);
  const api = apiFixture(["parseMultipart", "safeFileName", "safeRelativePath", "assertInside", "httpError",
    "validateArticleImageMetadata", "assertArticleImageContents", "detectArticleImageMime"], {
    ROOT: dir, MAX_UPLOAD_BYTES: 1048576, MAX_ARTICLE_IMAGE_BYTES: 64,
    ARTICLE_IMAGE_MIME_EXTENSIONS: new Map([["image/jpeg", new Set([".jpg"])]]),
    createMultipartParser: require("../apps/api/src/multipart-utils.cjs").createMultipartParser
  });
  async function upload(name, mime, bytes, malformedTail = false) {
    const boundary = "security-fixture";
    const req = Readable.from([Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cover"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
      bytes, Buffer.from(malformedTail ? `\r\n--${boundary}\r\nMalformed Header\r\n\r\nx\r\n--${boundary}--\r\n` : `\r\n--${boundary}--\r\n`)])]);
    req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    return api.parseMultipart(req);
  }
  await assert.rejects(upload("cover.html", "text/html", Buffer.from("<html>test</html>")), { statusCode: 415 });
  // The parser can emit another error from the same chunk after the first rejection.
  await assert.rejects(upload("cover.html", "text/html", Buffer.from("x"), true), { statusCode: 415 });
  await assert.rejects(upload("cover.jpg", "image/jpeg", Buffer.from("<html>test</html>")), { statusCode: 415 });
  await assert.rejects(upload("cover.jpg", "image/jpeg", Buffer.alloc(100)), { statusCode: 413 });
  const bytes = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
  const parsed = await upload("cover.jpg", "image/jpeg", bytes);
  assert.equal(parsed.files.cover.size, bytes.length);
  assert.deepEqual(await fsp.readFile(parsed.files.cover.tempPath), bytes);
});

test("legacy video disconnect handles the subsequent socket error and cleans its spool", async t => {
  const dir = await temp(t);
  const api = apiFixture(["parseMultipart", "safeFileName", "safeRelativePath", "assertInside", "httpError"], {
    ROOT: dir, MAX_UPLOAD_BYTES: 1048576,
    createMultipartParser: require("../apps/api/src/multipart-utils.cjs").createMultipartParser
  });
  const req = new PassThrough();
  req.headers = { "content-type": "multipart/form-data; boundary=abort-fixture" };
  const pending = api.parseMultipart(req);
  const rejection = assert.rejects(pending, /interrupted/);
  // Wait for the asynchronous directory creation to attach the real parser.
  while (!req.listenerCount("aborted")) await new Promise(resolve => setImmediate(resolve));
  req.write('--abort-fixture\r\nContent-Disposition: form-data; name="video"; filename="clip.mp4"\r\n\r\npartial');
  req.emit("aborted");
  req.destroy(new Error("socket reset"));
  await rejection;
  assert.deepEqual(await fsp.readdir(path.join(dir, "tmp")), []);
});

async function managerFixture(t, password) {
  const dir = await temp(t), filename = path.join(root, "scripts/manager-dashboard.cjs");
  const context = vm.createContext({ require: createRequire(filename), module: { exports: {} },
    __dirname: path.join(dir, "scripts"), process: { env: password ? { MANAGER_AUTH_PASSWORD: password } : {}, pid: process.pid },
    console, Buffer, URL, AbortSignal, fetch, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context);
  // Match asynchronous operation admission while keeping OS effects mocked.
  vm.runInContext(`var effects = []; withOperation = async (id, fn, accepted) => {
      accepted?.({ id: "00000000-0000-0000-0000-000000000001", label: id, state: "running", steps: [] });
      return fn();
    };
    handleStackAction = async action => effects.push(action);
    handleAction = async (service, action) => effects.push(service + ':' + action);
    handleWebModeChange = async mode => effects.push(mode);
    handleUploadTokenChange = async payload => effects.push('tokens'); allStatus = async () => ({});`, context);
  const { server, html } = context.module.exports;
  assert.equal(server.listening, false);
  // Establish a real server-side session; there is no Basic-auth bypass anymore.
  let cookie = "", nonce = "";
  if (password) {
    context.fixturePassword = password;
    vm.runInContext(`var sessionCookie;
      managerAuth.signIn({headers:{},socket:{}}, {setHeader(name,value){if(name==='Set-Cookie') sessionCookie=value.split(';')[0];}},
        {username:'admin',password:fixturePassword});`, context);
    cookie = context.sessionCookie;
    nonce = vm.runInContext('managerAuth.csrfToken({headers:{cookie:sessionCookie}})', context);
  }
  const page = html(nonce);
  new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
  return { effects: context.effects, nonce, cookie, async post(route, headers = {}) {
    const req = Readable.from([Buffer.from("{}")]);
    Object.assign(req, { method: "POST", url: route, headers: { host: "site.invalid", ...headers }, socket: { remoteAddress: "127.0.0.1" } });
    const res = new Reply(); await server.listeners("request")[0](req, res); await finished(res); return res;
  } };
}

test("Manager fails closed without credentials and every POST requires same-origin intent", async t => {
  const disabled = await managerFixture(t);
  assert.equal((await disabled.post("/api/upload-tokens", { "content-type": "application/json" })).status, 503);
  assert.equal(disabled.effects.length, 0);
  const mgr = await managerFixture(t, "synthetic-password");
  const auth = { cookie: mgr.cookie };
  const good = { ...auth, origin: "https://site.invalid", "content-type": "application/json", "x-manager-csrf": mgr.nonce };
  for (const route of ["/api/stack/stop-all", "/api/services/api/restart", "/api/services/web/mode/production", "/api/upload-tokens"]) {
    assert.equal((await mgr.post(route, { ...auth, "content-type": "application/x-www-form-urlencoded" })).status, 403);
    assert.equal((await mgr.post(route, { ...good, origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await mgr.post(route, { ...good, "sec-fetch-site": "cross-site" })).status, 403);
  }
  assert.equal(mgr.effects.length, 0);
  assert.equal((await mgr.post("/api/stack/stop-all", { ...good, cookie: "manager_session=invalid" })).status, 401);
  assert.equal((await mgr.post("/api/stack/stop-all", { ...good, "content-type": "text/plain" })).status, 415);
  for (const route of ["/api/stack/stop-all", "/api/services/api/restart", "/api/services/web/mode/production", "/api/upload-tokens"]) {
    assert.equal((await mgr.post(route, good)).status, route === "/api/upload-tokens" ? 200 : 202);
  }
  assert.equal(mgr.effects.length, 4);
});

test("health requests share a short probe, cache failures and refresh once after TTL", async () => {
  let clock = 0, calls = 0, release, succeed = true;
  const gate = new Promise(resolve => { release = resolve; });
  const extra = { FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe", MEDIA_ROOT: "fixture", DIRECTUS_URL: "fixture",
    UPLOAD_API_TOKEN: "", ARTICLE_API_TOKEN: "", ASSET_PRESETS: new Set(),
    resourceLimits: { maxPixels: 24_000_000 }, maintenanceMode: false,
    activeWriteRequests: 0, filmScanJobControllers: new Map(), filmScanQueue: [], activeFilmScanJobId: null,
    mediaProcessingSlots: { snapshot: () => ({ active: 0, pending: 0 }) },
    videoProcessingSlots: { snapshot: () => ({ active: 0, pending: 0 }) },
    // Health reports durable uploads independently from the FFmpeg admission queue.
    videoUploads: { snapshot: () => ({ sessions: 0, active: false, queued: 0 }) },
    createCachedProbe: probe => createCachedProbe(probe, { now: () => clock }),
    runProcess: async (command, args, options) => { calls++; assert.equal(options.timeoutMs, 5000); await gate; if (!succeed) throw new Error("unavailable"); },
    sendJson: (res, code, payload) => { res.payload = payload; }
  };
  for (const name of ["MAX_ARTICLE_UPLOAD_BYTES", "MAX_ARTICLE_IMAGE_BYTES", "MAX_ARTICLE_MARKDOWN_BYTES", "MAX_ARTICLE_IMAGES",
    "MAX_ALBUM_UPLOAD_BYTES", "MAX_ALBUM_IMAGE_BYTES", "MAX_ALBUM_PHOTOS", "MAX_FILM_SCAN_SOURCE_BYTES", "MAX_FILM_SCAN_JOB_BYTES", "MAX_FILM_SCAN_SOURCES"]) extra[name] = 1;
  const api = apiFixture(["commandAvailable", "handleHealth"], extra);
  vm.runInContext(apiSource.match(/^const getMediaHealth = createCachedProbe\([\s\S]*?^  \]\)\);/m)[0], api);
  const responses = Array.from({ length: 20 }, () => ({}));
  const pending = responses.map(res => api.handleHealth(res, true));
  await Promise.resolve(); assert.equal(calls, 2); release(); await Promise.all(pending);
  assert.equal(responses[0].payload.ffmpeg.available, true);
  await api.handleHealth({}, true); assert.equal(calls, 2);
  clock = 60001; succeed = false;
  const res = {}; await Promise.all([api.handleHealth(res, true), api.handleHealth({}, true)]);
  assert.equal(calls, 4); assert.equal(res.payload.ffmpeg.available, false);
  await api.handleHealth({}, true); assert.equal(calls, 4);
});

test("draft image transport never sends a token to external or rewritten URLs", async () => {
  const requests = [];
  const author = loadTs(path.join(root, "apps/web/src/lib/author-session.ts"));
  const { fetchAssetPreview } = loadTs(path.join(root, "apps/web/src/lib/asset-preview.ts"), { "./author-session": author }, {
    fetch: async (url, options) => { requests.push({ url, options }); return new Response("image"); },
  });
  const signal = new AbortController().signal;
  for (const url of ["https://attacker.invalid/api/assets/a", "//attacker.invalid/a", "/api/assets/../users", "/api/assets/a?redirect=https://attacker.invalid"]) {
    await assert.rejects(fetchAssetPreview(url, "secret", signal));
  }
  assert.equal(requests.length, 0);
  await fetchAssetPreview("/api/assets/draft?key=album-thumb", " secret ", signal);
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.cache, "no-store");
});

test("session-backed managed images keep the protected blob path with an empty manual token", async () => {
  const image = assetImageFixture({ author: { author: true, csrf: "session-nonce", expiresAt: Date.now() + 1000, article: false } });
  const view = image.render({ token: "", src: "/api/assets/draft", srcSet: "/api/assets/draft 640w", loading: "eager" });
  assert.equal(view.props.srcSet, undefined);
  assert.equal(image.requests.length, 1);
  assert.equal(image.requests[0].token, "");
  image.requests[0].resolve({});
  assert.equal((await image.flush()).props.src, "blob:fixture-1");
  image.unmount();
});

test("explicit site preview preserves draft images without making unrelated CMS files public", async () => {
  const env = { DIRECTUS_SHOW_DRAFTS: "false" };
  const assetHelpers = loadTs(path.join(root, "apps/web/src/lib/asset-url.ts"));
  const authorSession = loadTs(path.join(root, "apps/web/src/lib/author-session.ts"));
  const projectHelpers = loadTs(path.join(root, "apps/web/src/lib/external-projects.ts"), { "./author-session": authorSession });
  const directus = loadTs(path.join(root, "apps/web/src/lib/directus.ts"), { "./asset-url": assetHelpers, "./external-projects": projectHelpers }, { process: { env } });
  assert.equal(directus.assetUrl("cover"), "/api/assets/cover");
  env.DIRECTUS_SHOW_DRAFTS = "true";
  assert.equal(directus.assetUrl("cover", "content-card"), "/internal/preview/assets/cover?key=content-card");
  assert.equal(directus.previewAssetUrl("/api/assets/inline"), "/internal/preview/assets/inline");
  assert.equal(directus.previewAssetUrl("https://external.invalid/image.jpg"), "https://external.invalid/image.jpg");
  const data = {
    posts: [{ published: false, cover_image: "cover", content: "![x](/api/assets/inline)" }],
    video_projects: [{ published: false, cover_image: "video-cover" }],
    files: Object.fromEntries(["inline", "orphan"].map(id => [id, { description: `article-image:${crypto.randomUUID()}` }])),
  };
  let reads = 0;
  const route = loadTs(path.join(root, "apps/web/src/app/internal/preview/assets/[id]/route.ts"), {
    "@/lib/asset-url": assetHelpers,
    "@/lib/directus": { fetchDirectusPreview: async route => {
      reads++;
      if (route.startsWith("/assets/")) return new Response("draft bytes", { headers: { "content-type": "image/jpeg" } });
      return new Response(JSON.stringify(await cms(data)(route)));
    } },
  }, { process: { env }, fetch: async (url, options) => {
    assert.equal(options.headers, undefined); // Public fallback cannot borrow the CMS identity.
    assert.equal(options.redirect, "error");
    return url === "http://127.0.0.1:8060/assets/branding"
      ? new Response("public branding", { headers: { "content-type": "image/png" } }) : new Response(null, { status: 404 });
  } });
  async function get(id) {
    return route.GET(new Request(`http://site.invalid/internal/preview/assets/${id}`), { params: Promise.resolve({ id }) });
  }
  env.DIRECTUS_SHOW_DRAFTS = "false";
  assert.equal((await get("cover")).status, 404); assert.equal(reads, 0);
  env.DIRECTUS_SHOW_DRAFTS = "true";
  for (const id of ["cover", "inline", "video-cover", "branding"]) {
    const response = await get(id);
    assert.equal(response.status, 200, id);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await get("orphan")).status, 404);
  assert.equal((await get("unrelated")).status, 404);
  assert.equal(await canReadAsset("cover", {}, cms(data)), false); // Main API stays closed.
});
