const crypto = require("node:crypto");

const SESSION_MS = 6 * 60 * 60 * 1000;
const WINDOW_MS = 5 * 60 * 1000;
const digest = value => crypto.createHash("sha256").update(value).digest();
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function createAuthorSessions({ token, now = Date.now, trustProxy = false }) {
  const configured = Boolean(token && token !== "__REPLACE_WITH_RANDOM_UPLOAD_TOKEN__");
  const tokenDigest = digest(token || "");
  // A single API process owns these sessions; restarting it revokes every device.
  const sessions = new Map();
  let failures = 0;
  let windowStartedAt = now();

  function sessionKey(req) {
    const cookie = String(req.headers.cookie || "").split(";").map(part => part.trim())
      .find(part => part.startsWith("author_session="));
    const id = cookie?.slice("author_session=".length);
    return /^[a-f0-9]{64}$/.test(id || "") ? digest(id).toString("hex") : null;
  }

  function prune() {
    for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
  }

  function protocol(req) {
    return req.socket.encrypted || (trustProxy && req.headers["x-forwarded-proto"] === "https")
      ? "https:" : "http:";
  }

  function requireOrigin(req) {
    // Next rewrites Host to the upstream. Both Next and Nginx must overwrite
    // forwarding headers before TRUST_PROXY is enabled; never trust public peers.
    const host = trustProxy ? req.headers["x-forwarded-host"] || req.headers.host : req.headers.host;
    let sameOrigin = false;
    try {
      const origin = new URL(req.headers.origin);
      sameOrigin = ["http:", "https:"].includes(origin.protocol)
        && origin.origin === `${protocol(req)}//${host}` && origin.href === `${origin.origin}/`;
    } catch { /* Missing, null and malformed origins are not browser sign-ins. */ }
    if (!sameOrigin || req.headers["sec-fetch-site"] === "cross-site") {
      throw fail(403, "请求来源不受信任，请从本站重新操作。");
    }
  }

  function cookies(req, res, id, maxAge) {
    const attributes = `; SameSite=Strict; Max-Age=${maxAge}${protocol(req) === "https:" ? "; Secure" : ""}`;
    res.setHeader("Set-Cookie", [
      `author_session=${id}; Path=/api; HttpOnly${attributes}`,
      `author_hint=${id ? "1" : ""}; Path=/${attributes}`
    ]);
  }

  function requireSession(req) {
    prune();
    const session = sessions.get(sessionKey(req));
    if (!session) throw fail(401, "登录已过期，请重新登录。");
    if (["GET", "HEAD"].includes(req.method)) {
      // Same-origin browser reads normally omit Origin; CSRF is still required
      // below, and an explicitly supplied origin must match.
      if (req.headers.origin) requireOrigin(req);
      else if (req.headers["sec-fetch-site"] === "cross-site") throw fail(403, "请求来源不受信任。");
    } else requireOrigin(req);
    const csrf = req.headers["x-author-csrf"];
    if (typeof csrf !== "string" || !crypto.timingSafeEqual(digest(csrf), digest(session.csrf))) {
      throw fail(403, "登录状态已更新，请刷新后重试。");
    }
    return session;
  }

  return {
    requireOrigin,
    requireSession,
    requireReadSession(req) {
      prune();
      const session = sessions.get(sessionKey(req));
      if (!session) throw fail(401, "登录已过期，请重新登录。");
      if (req.headers.origin) requireOrigin(req);
      else if (req.headers["sec-fetch-site"] === "cross-site") throw fail(403, "请求来源不受信任。");
      return { ...session };
    },
    signIn(req, res, payload) {
      requireOrigin(req);
      if (!configured) throw fail(503, "作者登录尚未配置，请在 Manager 中设置上传令牌。");
      if (now() - windowStartedAt >= WINDOW_MS) { failures = 0; windowStartedAt = now(); }
      if (failures >= 10) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((windowStartedAt + WINDOW_MS - now()) / 1000))));
        throw fail(429, "尝试次数过多，请稍后再试。");
      }
      const valid = payload && typeof payload === "object" && !Array.isArray(payload)
        && Object.keys(payload).length === 1 && typeof payload.token === "string"
        && payload.token.length > 0 && payload.token.length <= 512;
      const matches = crypto.timingSafeEqual(digest(valid ? payload.token : ""), tokenDigest);
      if (!valid || !matches) { failures++; throw fail(401, "令牌不正确，请检查后重试。"); }
      failures = 0;
      prune();
      sessions.delete(sessionKey(req));
      while (sessions.size >= 16) sessions.delete(sessions.keys().next().value);
      const id = crypto.randomBytes(32).toString("hex");
      const session = { expiresAt: now() + SESSION_MS, csrf: crypto.randomBytes(32).toString("hex") };
      sessions.set(digest(id).toString("hex"), session);
      cookies(req, res, id, SESSION_MS / 1000);
      return { ...session };
    },
    status(req, res) {
      prune();
      const session = sessions.get(sessionKey(req));
      if (session) return { author: true, ...session };
      cookies(req, res, "", 0);
      return { author: false };
    },
    signOut(req, res) {
      requireSession(req);
      sessions.delete(sessionKey(req));
      cookies(req, res, "", 0);
      return { author: false };
    }
  };
}

module.exports = { createAuthorSessions };
