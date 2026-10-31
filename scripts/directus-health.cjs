const crypto = require("node:crypto");
const path = require("node:path");
const { loadEnvironment } = require("../config/resource-profile.cjs");
const tokens = new Map();
const logins = new Map();

/** Directus 12 health requires authentication; retain the real DB/storage health check. */
async function directusHealth(env, base, timeoutMs = 3000) {
  base ||= env.DIRECTUS_URL || `http://127.0.0.1:${env.PORT || 8055}`;
  base = base.replace(/\/$/, "");
  const email = env.DIRECTUS_HEALTH_EMAIL || env.DIRECTUS_EMAIL || env.ADMIN_EMAIL;
  const password = env.DIRECTUS_HEALTH_PASSWORD || env.DIRECTUS_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Configure a Directus health-check account.");
  const key = crypto.createHash("sha256").update(`${base}\0${email}\0${password}`).digest("hex");
  const signal = AbortSignal.timeout(timeoutMs);
  let cached = tokens.get(key);
  if (!cached || cached.expires <= Date.now()) {
    // Concurrent Manager/status requests share one login when the cached token expires.
    let login = logins.get(key);
    if (!login) {
      login = (async () => {
        const response = await fetch(`${base}/auth/login`, { method: "POST", signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`CMS health login failed (${response.status}).`); }
        const { data } = await response.json();
        if (!data?.access_token) throw new Error("CMS health login returned no token.");
        cached = { token: data.access_token, expires: Date.now() + Math.min(300_000, Math.max(1000, Number(data.expires || 300_000) - 30_000)) };
        if (tokens.size >= 4) tokens.delete(tokens.keys().next().value);
        tokens.set(key, cached);
        return cached;
      })().finally(() => logins.delete(key));
      logins.set(key, login);
    }
    cached = await login;
  }
  const response = await fetch(`${base}/server/health`, { signal,
    headers: { Authorization: `Bearer ${cached.token}` }, redirect: "error" });
  if (response.status === 401) tokens.delete(key);
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.status !== "ok") throw new Error(`CMS health check failed (${response.status}).`);
  return { status: response.status, ok: true };
}

if (require.main === module) {
  const env = loadEnvironment(process.env.CMS_ENV_FILE || path.resolve(__dirname, "../apps/cms/directus/.env"));
  directusHealth(env).then(() => console.log("CMS health: ok"))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { directusHealth };
