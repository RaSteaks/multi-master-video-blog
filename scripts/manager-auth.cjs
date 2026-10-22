const crypto = require("node:crypto");

const SESSION_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const COOKIE_NAME = "manager_session";
const digest = value => crypto.createHash("sha256").update(String(value)).digest();

function createManagerAuth({ username, password, basePath, now = Date.now }) {
  // Sessions are bounded, revocable and intentionally lost on Manager restart.
  // Only a random identifier reaches the browser; credentials never enter cookies.
  const sessions = new Map();
  let failures = 0;
  let windowStartedAt = now();
  let anonymousRequests = 0;
  let anonymousWindowStartedAt = now();
  const sessionKey = req => {
    const cookie = String(req.headers.cookie || "").split(";").map(part => part.trim())
      .find(part => part.startsWith(COOKIE_NAME + "="));
    const token = cookie?.slice(COOKIE_NAME.length + 1);
    return /^[a-f0-9]{64}$/.test(token || "") ? digest(token).toString("hex") : null;
  };
  function prune() {
    for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
  }
  function cookie(req, token, maxAge) {
    // Manager accepts loopback peers only. An HTTPS reverse proxy must set this
    // header itself, replacing any client-supplied value.
    const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
    return COOKIE_NAME + "=" + token + "; Path=" + (basePath || "/")
      + "; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + (secure ? "; Secure" : "");
  }
  return {
    hasSession(req) { prune(); return sessions.has(sessionKey(req)); },
    csrfToken(req) { prune(); return sessions.get(sessionKey(req))?.csrfToken || null; },
    requireAnonymousBudget(res) {
      // Bound unauthenticated page/API scanning too, including malformed login
      // requests. Keep one small budget instead of trusting spoofable proxy IPs.
      if (now() - anonymousWindowStartedAt >= 60000) { anonymousRequests = 0; anonymousWindowStartedAt = now(); }
      if (++anonymousRequests > 120) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((anonymousWindowStartedAt + 60000 - now()) / 1000))));
        throw Object.assign(new Error("请求过于频繁，请稍后再试。"), { statusCode: 429 });
      }
    },
    signIn(req, res, payload) {
      if (now() - windowStartedAt >= ATTEMPT_WINDOW_MS) { failures = 0; windowStartedAt = now(); }
      // A single-account console uses one bounded budget, including behind a
      // proxy; spoofed forwarding headers cannot bypass the attempt limit.
      if (failures >= 10) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((windowStartedAt + ATTEMPT_WINDOW_MS - now()) / 1000))));
        throw Object.assign(new Error("尝试次数过多，请稍后再试。"), { statusCode: 429 });
      }
      // Credentials are bounded literal strings, never SQL, shell fragments or
      // object filters. Reject extra privilege/command fields instead of coercing.
      const validShape = payload && typeof payload === "object" && !Array.isArray(payload)
        && Object.keys(payload).every(key => key === "username" || key === "password")
        && typeof payload.username === "string" && payload.username.length > 0 && payload.username.length <= 128
        && typeof payload.password === "string" && payload.password.length > 0 && payload.password.length <= 512;
      const validUsername = crypto.timingSafeEqual(digest(validShape ? payload.username : ""), digest(username));
      const validPassword = crypto.timingSafeEqual(digest(validShape ? payload.password : ""), digest(password));
      if (!password || !validShape || !validUsername || !validPassword) {
        failures++;
        throw Object.assign(new Error("账号或密码不正确。"), { statusCode: 401 });
      }
      failures = 0;
      prune();
      sessions.delete(sessionKey(req));
      while (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(digest(token).toString("hex"), {
        expiresAt: now() + SESSION_MS,
        csrfToken: crypto.randomBytes(32).toString("hex")
      });
      res.setHeader("Set-Cookie", cookie(req, token, SESSION_MS / 1000));
    },
    signOut(req, res) {
      sessions.delete(sessionKey(req));
      res.setHeader("Set-Cookie", cookie(req, "", 0));
    }
  };
}

module.exports = { createManagerAuth };
