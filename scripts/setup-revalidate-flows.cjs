/** Configure only flows owned by this script; never print credentials. */
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const root = path.resolve(__dirname, "..");
const env = (p) => parseEnv(fs.readFileSync(path.join(root, p), "utf8"));
async function main() {
  const cms = env("apps/cms/directus/.env");
  const web = env("apps/web/.env.production.local");
  if (!web.REVALIDATE_SECRET) throw new Error("Production REVALIDATE_SECRET is required");
  const base = "http://127.0.0.1:8055";
  let token;
  async function request(route, method = "GET", body) {
    const response = await fetch(base + route, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(method + " " + route + " failed: " + response.status);
    return response.status === 204 ? null : (await response.json()).data;
  }
  token = (await request("/auth/login", "POST", { email: cms.ADMIN_EMAIL, password: cms.ADMIN_PASSWORD })).access_token;
  const existing = await request("/flows?fields=id,name&limit=-1");
  for (const collection of ["posts", "video_projects", "albums", "album_photos", "site_settings"]) {
    for (const action of ["create", "update", "delete"]) {
      const name = "Web cache: " + collection + ":" + action;
      let flow = existing.find((f) => f.name === name);
      if (flow) { console.log("Already exists: " + name + " (unchanged)"); continue; }
      flow = await request("/flows", "POST", {
        name, status: "inactive", trigger: "event", accountability: "activity",
        description: "Managed by scripts/setup-revalidate-flows.cjs. Three HTTP attempts; terminal failure in CMS log. Keep TTL at 30s until monitored.",
        options: { type: "action", scope: ["items." + action], collections: [collection] },
      });
      const failure = await request("/operations", "POST", {
        flow: flow.id, key: "failure", name: "Log exhausted retries", type: "log", position_x: 80, position_y: 40,
        options: { message: "[revalidate-failed] " + collection + " items." + action + " after 3 attempts; inspect Web health; TTL fallback 30s; error={{ $last.message }}" },
      });
      let reject = failure.id;
      for (let attempt = 3; attempt >= 1; attempt--) {
        const op = await request("/operations", "POST", {
          flow: flow.id, key: "attempt_" + attempt, name: "Revalidate attempt " + attempt, type: "request",
          position_x: attempt * 20, position_y: 0, reject,
          options: { url: "http://127.0.0.1:3000/internal/revalidate", method: "POST",
            headers: [{ header: "x-revalidate-secret", value: web.REVALIDATE_SECRET }],
            body: "{{ $trigger }}" },
        });
        reject = op.id;
      }
      await request("/flows/" + flow.id, "PATCH", { operation: reject, status: "active" });
      console.log("Configured " + name);
    }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
