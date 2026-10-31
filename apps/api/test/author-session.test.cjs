const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAuthorSessions } = require("../src/author-session.cjs");

function fixture(options = {}) {
  let time = 0;
  const auth = createAuthorSessions({ token: "test-author-token", now: () => time, ...options });
  const headers = new Map();
  const res = { setHeader: (name, value) => headers.set(name, value) };
  const req = { headers: { host: "blog.test", origin: "http://blog.test" }, socket: {} };
  const login = () => auth.signIn(req, res, { token: "test-author-token" });
  const cookie = () => headers.get("Set-Cookie")[0].split(";", 1)[0];
  return { auth, req, res, headers, login, cookie, advance: ms => { time += ms; } };
}

test("author sessions rotate, expire at six hours without renewal and store separate cookies", () => {
  const f = fixture();
  const first = f.login();
  assert.equal(first.expiresAt, 21600000);
  assert.match(first.csrf, /^[a-f0-9]{64}$/);
  assert.match(f.headers.get("Set-Cookie")[0], /^author_session=[a-f0-9]{64}; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=21600$/);
  assert.match(f.headers.get("Set-Cookie")[1], /^author_hint=1; Path=\/; SameSite=Strict; Max-Age=21600$/);
  f.req.headers.cookie = f.cookie();
  const old = f.req.headers.cookie;
  f.login();
  const rotated = f.cookie();
  assert.equal(f.auth.status(f.req, f.res).author, false);
  f.req.headers.cookie = rotated;
  f.advance(21600000 - 1);
  assert.equal(f.auth.status(f.req, f.res).author, true);
  f.advance(1);
  assert.deepEqual(f.auth.status(f.req, f.res), { author: false });
  assert.ok(f.headers.get("Set-Cookie").every(value => value.includes("Max-Age=0")));
  f.req.headers.cookie = old;
  assert.equal(f.auth.status(f.req, f.res).author, false);
});

test("the eleventh attempt is throttled with the remaining window and resets after five minutes", () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) assert.throws(() => f.auth.signIn(f.req, f.res, { token: "wrong" }), { statusCode: 401 });
  f.advance(20_000);
  assert.throws(f.login, { statusCode: 429 });
  assert.equal(f.headers.get("Retry-After"), "280");
  f.advance(280_000);
  assert.doesNotThrow(f.login);
});

test("invalid payloads and disabled tokens cannot issue sessions", () => {
  for (const payload of [null, [], {}, { token: "" }, { token: 123 }, { token: "x".repeat(513) }, { token: "test-author-token", admin: true }]) {
    const f = fixture();
    assert.throws(() => f.auth.signIn(f.req, f.res, payload), { statusCode: 401 });
    assert.equal(f.headers.has("Set-Cookie"), false);
  }
  for (const token of ["", "__REPLACE_WITH_RANDOM_UPLOAD_TOKEN__"]) {
    const f = fixture({ token });
    assert.throws(f.login, { statusCode: 503 });
    assert.equal(f.headers.has("Set-Cookie"), false);
  }
});

test("seventeen devices evict only the oldest, logout revokes only its session, restart revokes all", () => {
  const f = fixture();
  const cookies = [];
  const sessions = [];
  for (let i = 0; i < 17; i++) { sessions.push(f.login()); cookies.push(f.cookie()); f.advance(1); }
  f.req.headers.cookie = cookies[0];
  assert.equal(f.auth.status(f.req, f.res).author, false);
  f.req.headers.cookie = cookies[1];
  f.req.headers["x-author-csrf"] = sessions[1].csrf;
  assert.equal(f.auth.status(f.req, f.res).author, true);
  f.auth.signOut(f.req, f.res);
  assert.equal(f.auth.status(f.req, f.res).author, false);
  f.req.headers.cookie = cookies[16];
  assert.equal(f.auth.status(f.req, f.res).author, true);
  assert.equal(fixture().auth.status(f.req, f.res).author, false);
});

test("mutations reject missing/null/cross-origin origins, cross-site fetches and another session's CSRF", () => {
  const f = fixture();
  const signed = f.login(); f.req.headers.cookie = f.cookie();
  f.req.headers["x-author-csrf"] = signed.csrf;
  for (const origin of [undefined, "null", "https://blog.test", "http://other.test", "http://blog.test:90", "http://blog.test/path"]) {
    f.req.headers.origin = origin;
    assert.throws(() => f.auth.signOut(f.req, f.res), { statusCode: 403 });
    assert.throws(f.login, { statusCode: 403 });
  }
  f.req.headers.origin = "http://blog.test";
  f.req.headers["sec-fetch-site"] = "cross-site";
  assert.throws(() => f.auth.requireSession(f.req), { statusCode: 403 });
  delete f.req.headers["sec-fetch-site"];
  for (const csrf of [undefined, "wrong", fixture().login().csrf]) {
    f.req.headers["x-author-csrf"] = csrf;
    assert.throws(() => f.auth.signOut(f.req, f.res), { statusCode: 403 });
  }
  f.req.headers["x-author-csrf"] = signed.csrf;
  assert.doesNotThrow(() => f.auth.requireSession(f.req));
  f.advance(21600000);
  assert.throws(() => f.auth.requireSession(f.req), { statusCode: 401 });
});

test("trusted Next/Nginx forwarding preserves the external host, port and Secure attribute", () => {
  const f = fixture({ trustProxy: true });
  Object.assign(f.req.headers, { host: "127.0.0.1:8060", origin: "https://blog.test:8443",
    "x-forwarded-host": "blog.test:8443", "x-forwarded-proto": "https" });
  f.login();
  assert.ok(f.headers.get("Set-Cookie").every(value => value.endsWith("; Secure")));
  assert.throws(() => fixture().auth.signIn(f.req, f.res, { token: "test-author-token" }), { statusCode: 403 });
});

test("HTTPS login on a non-default port requires the proxy to preserve the public port", () => {
  const f = fixture({ trustProxy: true });
  // Nginx $host omits the public port. $http_host must be forwarded separately.
  Object.assign(f.req.headers, { host: "blog.test", origin: "https://blog.test:8443", "x-forwarded-proto": "https" });
  assert.throws(f.login, error => error.statusCode === 403 && /请求来源/.test(error.message));
  assert.equal(f.headers.has("Set-Cookie"), false);
  f.req.headers["x-forwarded-host"] = "blog.test:8443";
  f.login();
  assert.ok(f.headers.get("Set-Cookie").every(cookie => cookie.endsWith("; Secure")));
  for (const origin of ["https://blog.test", "https://blog.test:8444", "http://blog.test:8443", "https://other.test:8443"]) {
    f.req.headers.origin = origin;
    assert.throws(f.login, { statusCode: 403 });
  }
});

test("protected GETs accept normal same-origin reads without Origin but still require CSRF", () => {
  const f = fixture(); const signed = f.login();
  f.req.headers.cookie = f.cookie(); f.req.method = "GET";
  delete f.req.headers.origin;
  assert.throws(() => f.auth.requireSession(f.req), { statusCode: 403 });
  f.req.headers["x-author-csrf"] = signed.csrf;
  assert.doesNotThrow(() => f.auth.requireSession(f.req));
  assert.doesNotThrow(() => f.auth.requireReadSession(f.req));
  f.req.headers["sec-fetch-site"] = "cross-site";
  assert.throws(() => f.auth.requireSession(f.req), { statusCode: 403 });
  assert.throws(() => f.auth.requireReadSession(f.req), { statusCode: 403 });
});

test("server-issued device hint lasts a year, never authorizes and survives expiry/logout until forgotten", () => {
  const f = fixture();
  const session = f.login();
  assert.equal(f.headers.get("Set-Cookie")[2], "author_device=1; Path=/; SameSite=Strict; Max-Age=31536000");
  f.req.headers.cookie = "author_device=1";
  assert.throws(() => f.auth.requireSession(f.req), { statusCode: 401 });
  assert.equal(f.auth.status(f.req, f.res).author, false);
  assert.equal(f.headers.get("Set-Cookie").some(cookie => cookie.startsWith("author_device=")), false);
  const second = f.login();
  f.req.headers.cookie = f.cookie(); f.req.headers["x-author-csrf"] = second.csrf;
  f.auth.signOut(f.req, f.res);
  assert.equal(f.headers.get("Set-Cookie").some(cookie => cookie.startsWith("author_device=")), false);
  f.advance(session.expiresAt);
  f.auth.signOut(f.req, f.res, true);
  assert.equal(f.headers.get("Set-Cookie")[2], "author_device=; Path=/; SameSite=Strict; Max-Age=0");
  f.req.headers.origin = "http://attacker.test";
  assert.throws(() => f.auth.signOut(f.req, f.res, true), { statusCode: 403 });
});
