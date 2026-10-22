const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { createManagerAuth } = require("../scripts/manager-auth.cjs");
const { startAuthFixture } = require("./helpers/manager-auth-fixture.cjs");

test("sessions rotate, expire, revoke, remain bounded and use protected cookies", () => {
  let time = 0;
  const auth = createManagerAuth({ username: "admin", password: "test", basePath: "/manager", now: () => time });
  let header;
  const res = { setHeader(name, value) { if (name === "Set-Cookie") header = value; } };
  const req = { headers: { "x-forwarded-proto": "https" }, socket: {} };
  const login = () => auth.signIn(req, res, { username: "admin", password: "test" });
  login();
  assert.match(header, /Path=\/manager; HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.doesNotMatch(header, /admin|test/);
  const first = header.split(";")[0]; req.headers.cookie = first;
  assert.ok(auth.hasSession(req));
  login();
  assert.equal(auth.hasSession(req), false, "A login rotates the previous session");
  req.headers.cookie = header.split(";")[0];
  auth.signOut(req, res);
  assert.equal(auth.hasSession(req), false);
  assert.match(header, /Max-Age=0/);
  login(); req.headers.cookie = header.split(";")[0];
  time += 8 * 60 * 60 * 1000;
  assert.equal(auth.hasSession(req), false);
  login(); const oldest = header.split(";")[0];
  req.headers.cookie = "";
  for (let n = 0; n < 32; n++) login();
  req.headers.cookie = oldest;
  assert.equal(auth.hasSession(req), false, "The oldest session is evicted at capacity");
  req.headers.cookie = header.split(";")[0];
  assert.equal(createManagerAuth({ username: "admin", password: "test", basePath: "/manager" }).hasSession(req), false);
});

test("login throttles invalid credentials without trusting spoofed client addresses", () => {
  let time = 0;
  const auth = createManagerAuth({ username: "admin", password: "test", basePath: "", now: () => time });
  const req = { headers: {}, socket: {} }, res = { setHeader() {} };
  for (let n = 0; n < 10; n++) {
    req.headers["x-forwarded-for"] = "192.0.2." + n;
    assert.throws(() => auth.signIn(req, res, { username: "admin", password: "wrong" }), { statusCode: 401 });
  }
  assert.throws(() => auth.signIn(req, res, { username: "admin", password: "test" }), { statusCode: 429 });
  time += 5 * 60 * 1000;
  assert.doesNotThrow(() => auth.signIn(req, res, { username: "admin", password: "test" }));
});

test("HTTP login protects pages and APIs, separates CSRF nonces and revokes logout", async t => {
  for (const basePath of ["/manager", "", "/private/control"]) {
    const fixture = await startAuthFixture({ basePath }); t.after(() => fixture.close());
    const url = fixture.url + basePath;
    const page = await fetch(url || fixture.url, { redirect: "manual" });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), basePath + "/login");
    assert.equal(page.headers.get("www-authenticate"), null);
    const loginResponse = await fetch(url + "/login");
    const loginPage = await loginResponse.text();
    assert.match(loginPage, /登录管理控制台/);
    assert.equal(loginResponse.headers.get("x-frame-options"), "DENY");
    assert.doesNotMatch(loginPage, /fixture-password-only/);
    new vm.Script(loginPage.match(/<script>([\s\S]*?)<\/script>/)[1]);
    const nonce = loginPage.match(/LOGIN_NONCE = "([a-f0-9]+)"/)[1];
    const headers = { "content-type": "application/json", "x-manager-csrf": nonce, origin: fixture.url };
    const body = JSON.stringify({ username: "admin", password: fixture.password });
    const post = (route, extra = {}, payload = body) => fetch(url + route, { method: "POST", headers: { ...headers, ...extra }, body: payload });
    assert.equal((await fetch(url + "/api/status")).status, 401);
    assert.equal((await post("/api/login", { "x-manager-csrf": "" })).status, 403);
    assert.equal((await post("/api/login", { origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await post("/api/login", { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post("/api/login", { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("/api/login", {}, JSON.stringify({ username: "admin", password: "wrong" }))).status, 401);
    const accepted = await post("/api/login");
    assert.equal(accepted.status, 200);
    const cookie = accepted.headers.get("set-cookie").split(";")[0];
    const dashboard = await fetch(url || fixture.url, { headers: { cookie } });
    assert.equal(dashboard.status, 200);
    const dashboardHtml = await dashboard.text();
    const mutationNonce = dashboardHtml.match(/"X-Manager-CSRF": "([a-f0-9]+)"/)[1];
    assert.notEqual(mutationNonce, nonce);
    assert.match(dashboardHtml, /退出登录/);
    assert.equal((await fetch(url + "/api/status", { headers: { cookie } })).status, 200);
    assert.equal((await fetch(url + "/login", { headers: { cookie }, redirect: "manual" })).status, 303);
    assert.equal((await post("/api/logout", { cookie })).status, 403);
    assert.equal((await post("/api/services/web/restart", { cookie })).status, 403);
    const logout = await post("/api/logout", { cookie, "x-manager-csrf": mutationNonce });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await fetch(url + "/api/status", { headers: { cookie } })).status, 401);
    const basic = "Basic " + Buffer.from("admin:" + fixture.password).toString("base64");
    assert.equal((await fetch(url + "/api/status", { headers: { authorization: basic } })).status, 401);
    assert.equal((await fetch(url || fixture.url, { headers: { authorization: basic }, redirect: "manual" })).status, 303);
  }
});

test("rotated sessions distinguish stale page nonces from origin and authentication failures", async t => {
  for (const basePath of ["/manager", "", "/private/control"]) {
    const fixture = await startAuthFixture({ basePath }); t.after(() => fixture.close());
    const root = fixture.url + basePath;
    const loginPage = await (await fetch(root + "/login")).text();
    const loginNonce = loginPage.match(/LOGIN_NONCE = "([a-f0-9]+)"/)[1];
    const headers = { "content-type": "application/json", origin: fixture.url };
    const post = (route, extra, body = "{}") => fetch(root + route, {
      method: "POST", headers: { ...headers, ...extra }, body
    });
    const login = cookie => post("/api/login", { cookie, "x-manager-csrf": loginNonce },
      JSON.stringify({ username: "admin", password: fixture.password }));
    const first = await login("");
    const oldCookie = first.headers.get("set-cookie").split(";")[0];
    const oldPage = await (await fetch(root, { headers: { cookie: oldCookie } })).text();
    const oldNonce = oldPage.match(/"X-Manager-CSRF": "([a-f0-9]+)"/)[1];
    const second = await login(oldCookie);
    const cookie = second.headers.get("set-cookie").split(";")[0];
    const stale = { cookie, "x-manager-csrf": oldNonce };
    // The browser sends the new shared cookie even while an old tab keeps its nonce.
    assert.equal((await fetch(root + "/api/status", { headers: { cookie } })).status, 200);
    vm.runInContext("var serviceActions = 0; handleAction = async () => { serviceActions++; };", fixture.context);
    for (const route of ["/api/services/web/restart", "/api/logout"]) {
      const rejected = await post(route, stale);
      assert.equal(rejected.status, 403);
      assert.equal((await rejected.json()).code, "MANAGER_CSRF_MISMATCH");
    }
    assert.equal(fixture.context.serviceActions, 0, "A stale request must not start work");
    for (const extra of [{ origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }]) {
      const rejected = await post("/api/logout", { ...stale, ...extra });
      assert.equal(rejected.status, 403);
      assert.equal((await rejected.json()).code, undefined, "Origin failures must not trigger session recovery");
    }
    assert.equal((await post("/api/logout", { ...stale, cookie: oldCookie })).status, 401);
    const newPage = await (await fetch(root, { headers: { cookie } })).text();
    const nonce = newPage.match(/"X-Manager-CSRF": "([a-f0-9]+)"/)[1];
    assert.notEqual(nonce, oldNonce);
    assert.equal((await post("/api/logout", { cookie, "x-manager-csrf": nonce })).status, 200);
  }
});

test("credentials reject SQL/command strings, object filters, privilege fields and oversized values", () => {
  const payloads = [
    { username: "admin' OR '1'='1' --", password: "anything" },
    { username: "admin", password: "' OR 1=1; DROP TABLE users; --" },
    { username: "admin", password: "$(whoami); powershell -Command whoami" },
    { username: { $ne: null }, password: { $ne: null } },
    { username: ["admin"], password: ["test"] },
    { username: "admin", password: "test", isAdmin: true },
    JSON.parse('{"username":"admin","password":"test","__proto__":{"isAdmin":true}}'),
    { username: "a".repeat(129), password: "test" },
    { username: "admin", password: "x".repeat(513) },
    null
  ];
  const req = { headers: {}, socket: {} };
  for (const payload of payloads) {
    // A fresh instance isolates shape validation from the separate lockout test.
    const auth = createManagerAuth({ username: "admin", password: "test", basePath: "/manager" });
    const res = { setHeader() { assert.fail("Invalid credentials must not issue a cookie"); } };
    assert.throws(() => auth.signIn(req, res, payload), { statusCode: 401 });
    assert.equal(auth.hasSession(req), false);
  }
  // SQL-looking punctuation is harmless literal data, not a brittle blacklist.
  const literal = "safe'\";$(not-a-command)";
  const auth = createManagerAuth({ username: "admin", password: literal, basePath: "" });
  assert.doesNotThrow(() => auth.signIn(req, { setHeader() {} }, { username: "admin", password: literal }));
});

test("anonymous scan budget recovers after a minute and cannot grow an IP map", () => {
  let time = 0, retryAfter;
  const auth = createManagerAuth({ username: "admin", password: "test", basePath: "", now: () => time });
  const res = { setHeader(name, value) { if (name === "Retry-After") retryAfter = value; } };
  for (let n = 0; n < 120; n++) auth.requireAnonymousBudget(res);
  assert.throws(() => auth.requireAnonymousBudget(res), { statusCode: 429 });
  assert.equal(retryAfter, "60");
  time = 60000;
  assert.doesNotThrow(() => auth.requireAnonymousBudget(res));
});

test("HTTP protection binds mutation tokens to sessions and rejects unauthenticated tampering", async t => {
  const fixture = await startAuthFixture(); t.after(() => fixture.close());
  const root = fixture.url + fixture.basePath;
  const loginPage = await (await fetch(root + "/login")).text();
  const nonce = loginPage.match(/LOGIN_NONCE = "([a-f0-9]+)"/)[1];
  const headers = { "content-type": "application/json", "x-manager-csrf": nonce, origin: fixture.url };
  const post = (route, body, extra = {}) => fetch(root + route, { method: "POST", headers: { ...headers, ...extra }, body });
  const credentials = JSON.stringify({ username: "admin", password: fixture.password });
  const sessions = [];
  for (let i = 0; i < 2; i++) {
    const accepted = await post("/api/login", credentials);
    const cookie = accepted.headers.get("set-cookie").split(";")[0];
    const response = await fetch(root, { headers: { cookie } });
    const page = await response.text();
    sessions.push({ cookie, nonce: page.match(/"X-Manager-CSRF": "([a-f0-9]+)"/)[1] });
    assert.match(response.headers.get("content-security-policy"), /script-src 'sha256-/);
    assert.doesNotMatch(response.headers.get("content-security-policy").split("script-src ")[1].split(";")[0], /unsafe-inline|unsafe-eval/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("x-robots-tag"), /noindex/);
  }
  assert.notEqual(sessions[0].nonce, sessions[1].nonce);
  assert.equal((await post("/api/logout", "{}", { cookie: sessions[1].cookie, "x-manager-csrf": sessions[0].nonce })).status, 403);
  for (const route of ["/api/services/web/restart", "/api/stack/stop-all", "/api/upload-tokens"]) {
    assert.equal((await post(route, '{"isAdmin":true}', { cookie: "manager_session=" + "a".repeat(64), "x-manager-csrf": sessions[0].nonce })).status, 401);
  }
  for (const route of ["/api/status", "/api/logs/web", "/api/logs/%2e%2e%2f.env"]) {
    assert.equal((await fetch(root + route)).status, 401);
  }
  const poisoned = await post("/api/login", '{"username":"admin","password":"never-echo-this-secret", invalid}');
  assert.equal(poisoned.status, 400);
  assert.doesNotMatch(await poisoned.text(), /never-echo-this-secret/);
  assert.equal((await post("/api/login", JSON.stringify({ username: "admin", password: "x".repeat(5000) }))).status, 413);
  assert.equal((await post("/api/services/web%3Bwhoami/restart", "{}", { cookie: sessions[0].cookie, "x-manager-csrf": sessions[0].nonce })).status, 404);
  assert.equal((await post("/api/logout", "{}", { cookie: sessions[0].cookie, "x-manager-csrf": sessions[0].nonce })).status, 200);
  assert.equal((await post("/api/logout", "{}", { cookie: sessions[0].cookie, "x-manager-csrf": sessions[0].nonce })).status, 401);

  // Scanning is throttled before rendering; existing authenticated users retain
  // status access even when the shared anonymous budget is exhausted.
  let last;
  for (let i = 0; i < 121; i++) last = await fetch(root + "/login");
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  assert.equal((await fetch(root + "/api/status", { headers: { cookie: sessions[1].cookie } })).status, 200);
});

test("missing Manager password still fails closed", async t => {
  const fixture = await startAuthFixture({ password: "" }); t.after(() => fixture.close());
  assert.equal((await fetch(fixture.url + "/manager/login")).status, 503);
  assert.equal((await fetch(fixture.url + "/manager/api/login", { method: "POST" })).status, 503);
});
