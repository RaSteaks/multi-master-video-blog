const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDirectusClient } = require("../src/directus-client.cjs");

// Exercise the exported client with real Response/FormData and disposable files;
// only the external CMS transport is replaced, without changing global fetch.
function client(fetch) {
  return createDirectusClient({ url: "http://fixture.invalid/", email: "fixture@example.invalid", password: "fixture", fetch });
}

async function uploadFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "directus-client-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = { tempPath: path.join(directory, "image.bin"), filename: "image.bin", mimeType: "image/jpeg" };
  const bytes = Buffer.alloc(1024 * 1024, 73);
  await fs.writeFile(file.tempPath, bytes);
  return { file, bytes };
}

test("client shares login and preserves JSON request options", async () => {
  let logins = 0;
  const controller = new AbortController();
  const api = client(async (url, options) => {
    if (url.endsWith("/auth/login")) {
      logins++;
      assert.deepEqual(JSON.parse(options.body), { email: "fixture@example.invalid", password: "fixture" });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ data: { access_token: "fresh-token", expires: 60_000 } });
    }
    assert.equal(url, "http://fixture.invalid/items/posts");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { title: "Example" });
    assert.equal(options.headers.Authorization, "Bearer fresh-token");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.headers["X-Fixture"], "test");
    assert.equal(options.signal, controller.signal);
    return Response.json({ data: { id: 1 } });
  });
  assert.deepEqual(await Promise.all([api.directusLogin(), api.directusLogin()]), ["fresh-token", "fresh-token"]);
  assert.equal(await api.directusLogin(), "fresh-token");
  assert.deepEqual(await api.directusRequest("/items/posts", "fresh-token", {
    method: "POST", body: { title: "Example" }, headers: { "X-Fixture": "test" }, signal: controller.signal
  }), { data: { id: 1 } });
  assert.equal(logins, 1);
});

test("JSON requests retry a 401 once, release its body, and retain the request payload", async () => {
  let attempts = 0, logins = 0;
  const unauthorized = new Response("expired", { status: 401 });
  const api = client(async (url, options) => {
    if (url.endsWith("/auth/login")) {
      logins++;
      assert.equal(unauthorized.bodyUsed, true);
      return Response.json({ data: { access_token: "fresh-token", expires: 60_000 } });
    }
    attempts++;
    assert.equal(options.body, '{"title":"Example"}');
    assert.equal(options.headers.Authorization, attempts === 1 ? "Bearer expired" : "Bearer fresh-token");
    return attempts === 1 ? unauthorized : new Response("still unauthorized", { status: 401 });
  });
  await assert.rejects(api.directusRequest("/items/posts", "expired", { method: "POST", body: { title: "Example" } }), {
    statusCode: 401, directusHttpStatus: 401, directusRequestSent: true
  });
  assert.equal(attempts, 2);
  assert.equal(logins, 1);
});

test("file-backed multipart content survives an authentication retry", async t => {
  const { file, bytes } = await uploadFile(t);
  let attempts = 0, logins = 0;
  const unauthorized = new Response("expired", { status: 401 });
  const api = client(async (url, options) => {
    if (url.endsWith("/auth/login")) {
      logins++;
      assert.equal(unauthorized.bodyUsed, true);
      return Response.json({ data: { access_token: "fresh-token", expires: 60_000 } });
    }
    attempts++;
    const image = options.body.get("file");
    assert.equal(image.name, "image.bin");
    assert.equal(image.type, "image/jpeg");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    assert.equal(options.body.get("title"), "Test");
    assert.equal(options.body.get("description"), "batch-tag");
    assert.equal(options.headers.Authorization, attempts === 1 ? "Bearer expired" : "Bearer fresh-token");
    return attempts === 1 ? unauthorized : Response.json({ data: { id: "file-id" } });
  });
  assert.equal(await api.directusUploadFile("expired", file, "Test", { reconciliationTag: "batch-tag" }), "file-id");
  assert.equal(attempts, 2);
  assert.equal(logins, 1);
});

test("upload HTTP rejections retain their status for JSON, HTML, and truncated bodies", async t => {
  const { file } = await uploadFile(t);
  for (const status of [401, 403, 413, 500]) {
    for (const body of ["json", "html", "truncated"]) {
      await t.test(`${status} ${body}`, async () => {
        let uploads = 0, lookups = 0;
        const cause = new Error("response stream failed");
        const api = client(async url => {
          if (url.endsWith("/auth/login")) {
            return Response.json({ data: { access_token: "fresh-token", expires: 60_000 } });
          }
          if (url.includes("/files?")) {
            lookups++;
            return Response.json({ data: [] });
          }
          uploads++;
          if (body === "truncated") {
            return new Response(new ReadableStream({ start(controller) { controller.error(cause); } }), { status });
          }
          return new Response(body === "json" ? '{"errors":[{"message":"rejected"}]}' : "<html>rejected</html>", { status });
        });
        await assert.rejects(api.directusUploadFile("token", file, "Test", { reconciliationTag: "batch" }), error => {
          assert.equal(error.statusCode, status);
          assert.equal(error.directusHttpStatus, status);
          assert.equal(error.directusRequestSent, true);
          assert.notEqual(error.directusAmbiguous, true);
          if (body === "truncated") assert.equal(error.cause, cause);
          return true;
        });
        assert.equal(uploads, status === 401 ? 2 : 1);
        assert.equal(lookups, 0, "definite rejection must not trigger uncertain-write reconciliation");
      });
    }
  }
});

test("transport failures mark only mutations as uncertain writes", async () => {
  const cause = new Error("connection lost");
  const api = client(async () => { throw cause; });
  for (const method of ["GET", "HEAD", "DELETE", "POST", "PATCH", "PUT"]) {
    await assert.rejects(api.directusRequest("/items/posts/1", "token", { method }), {
      statusCode: 502, directusRequestSent: true,
      directusAmbiguous: ["POST", "PATCH", "PUT"].includes(method), cause
    });
  }
});

test("invalid successful responses preserve uncertain-write handling and allow empty DELETE/HEAD", async () => {
  const malformed = client(async () => new Response("not JSON"));
  const empty = client(async () => new Response(null));
  for (const method of ["GET", "POST", "PATCH", "PUT"]) {
    for (const api of [malformed, empty]) {
      await assert.rejects(api.directusRequest("/items/posts/1", "token", { method }), {
        statusCode: 502, directusResponseStatus: 200, directusRequestSent: true,
        directusAmbiguous: method !== "GET"
      });
    }
  }
  assert.equal(await empty.directusRequest("/items/posts/1", "token", { method: "DELETE" }), null);
  assert.equal(await empty.directusRequest("/items/posts/1", "token", { method: "HEAD" }), null);
});

test("unverifiable upload results reconcile by tag without repeating the mutation", async t => {
  const { file } = await uploadFile(t);
  const cause = new Error("connection lost");
  const responses = {
    transport: () => { throw cause; },
    truncated: () => new Response(new ReadableStream({ start(controller) { controller.error(cause); } })),
    malformed: () => new Response("not JSON"),
    empty: () => new Response(null),
    missingId: () => Response.json({ data: {} }),
    invalidId: () => Response.json({ data: { id: { invalid: true } } })
  };
  for (const [name, response] of Object.entries(responses)) {
    await t.test(name, async () => {
      let uploads = 0, lookups = 0;
      const api = client(async (url, options) => {
        if (options.method === "POST") {
          uploads++;
          return response();
        }
        lookups++;
        const params = new URL(url).searchParams;
        assert.equal(params.get("filter[description][_eq]"), "batch-tag");
        assert.equal(params.get("limit"), "2");
        return Response.json({ data: [{ id: "committed-file", description: "batch-tag" }] });
      });
      assert.equal(await api.directusUploadFile("token", file, "Test", { reconciliationTag: "batch-tag" }), "committed-file");
      assert.equal(uploads, 1);
      assert.equal(lookups, 1);
    });
  }
});

test("reconciliation failure retains both the uncertain upload and lookup error", async t => {
  const { file } = await uploadFile(t);
  const cause = new Error("connection lost");
  const api = client(async (url, options) => {
    if (options.method === "POST") throw cause;
    return Response.json({ data: [{ id: "one" }, { id: "two" }] });
  });
  await assert.rejects(api.directusUploadFile("token", file, "Test", { reconciliationTag: "duplicate-tag" }), error => {
    assert.equal(error.cause, cause);
    assert.equal(error.directusAmbiguous, true);
    assert.equal(error.reconciliationError.statusCode, 409);
    return true;
  });
});

test("asset retry preserves conditional headers, method, cancellation and the upstream response", async () => {
  const controller = new AbortController();
  const unauthorized = new Response("expired", { status: 401 });
  const notModified = new Response(null, { status: 304 });
  let attempts = 0;
  const api = client(async (url, options) => {
    if (url.endsWith("/auth/login")) {
      assert.equal(unauthorized.bodyUsed, true);
      return Response.json({ data: { access_token: "fresh-token", expires: 60_000 } });
    }
    attempts++;
    assert.equal(options.method, "HEAD");
    assert.equal(options.signal, controller.signal);
    assert.deepEqual(options.headers, {
      Authorization: attempts === 1 ? "Bearer expired" : "Bearer fresh-token",
      "If-None-Match": '"version"', "If-Modified-Since": "Mon, 26 Oct 2026 00:00:00 GMT"
    });
    return attempts === 1 ? unauthorized : notModified;
  });
  const response = await api.fetchDirectusAsset("http://fixture.invalid/assets/file", "expired", {
    "if-none-match": '"version"', "if-modified-since": "Mon, 26 Oct 2026 00:00:00 GMT", cookie: "private"
  }, "HEAD", false, controller.signal);
  assert.equal(response, notModified);
  assert.equal(attempts, 2);
});

test("service login failures map to 502 and a later login can recover", async () => {
  let attempts = 0;
  const api = client(async () => {
    attempts++;
    return attempts === 1
      ? new Response("Forbidden", { status: 403 })
      : Response.json({ data: { access_token: "recovered", expires: 60_000 } });
  });
  await assert.rejects(api.directusLogin(), error => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.cause.directusHttpStatus, 403);
    return true;
  });
  assert.equal(await api.directusLogin(), "recovered");
  assert.equal(attempts, 2);
});
