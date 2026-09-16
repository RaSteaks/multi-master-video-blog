const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const API_ROOT = path.join(REPO_ROOT, "apps", "api");
const env = readEnv(path.join(API_ROOT, ".env"));
const apiUrl = `http://${env.HOST || "127.0.0.1"}:${env.PORT || "8060"}`;
const directusUrl = String(
  env.DIRECTUS_URL || "http://127.0.0.1:8055"
).replace(/\/$/, "");
const mediaRoot = path.resolve(API_ROOT, env.MEDIA_ROOT || "../../media");

function readEnv(filePath) {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error ||
        payload?.errors?.[0]?.message ||
        `${options.method || "GET"} ${url} failed with HTTP ${response.status}`
    );
  }
  return payload;
}

async function waitForFailedJob(albumId, jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const payload = await request(
      `${apiUrl}/albums/${albumId}/film-scans/${jobId}`,
      {
        headers: {
          Authorization: `Bearer ${env.UPLOAD_API_TOKEN}`
        }
      }
    );
    if (payload.job.status === "failed") return payload.job;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`film scan job ${jobId} did not fail within 30 seconds`);
}

async function directusLogin() {
  const payload = await request(`${directusUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: env.DIRECTUS_EMAIL,
      password: env.DIRECTUS_PASSWORD
    })
  });
  return payload.data.access_token;
}

async function main() {
  const managed = await request(`${apiUrl}/albums/manage`, {
    headers: { Authorization: `Bearer ${env.UPLOAD_API_TOKEN}` }
  });
  const album = managed.albums?.[0];
  assert.ok(album?.id, "cleanup test requires at least one album");

  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      scanner: "hasselblad-x5",
      frameFormat: "135-full",
      filmType: "color-negative",
      filmStock: "Cleanup Test Film",
      iso: 100,
      process: "c41",
      pushPull: 0,
      adjustments: {}
    })
  );
  form.append(
    "sources",
    new Blob([
      Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
    ], { type: "image/tiff" }),
    `cleanup-test-${Date.now()}.tif`
  );

  let jobId = null;
  try {
    const created = await request(
      `${apiUrl}/albums/${album.id}/film-scans`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.UPLOAD_API_TOKEN}` },
        body: form
      }
    );
    jobId = created.job.id;
    const failed = await waitForFailedJob(album.id, jobId);
    assert.match(failed.error || "", /解码失败/);
    assert.equal(failed.sources?.length ?? 0, 0);
    assert.equal(failed.frames.length, 0);
    await assert.rejects(
      fsp.access(path.join(mediaRoot, "film-scans", String(jobId)))
    );
    console.log(`film_scan_cleanup=ok job=${jobId} files=deleted records=deleted`);
  } finally {
    if (jobId) {
      const token = await directusLogin();
      await fetch(`${directusUrl}/items/film_scan_jobs/${jobId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
