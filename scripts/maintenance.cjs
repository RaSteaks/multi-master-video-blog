const path = require("node:path");
const { loadEnvironment } = require("../config/resource-profile.cjs");
const env = loadEnvironment(process.env.API_ENV_FILE || path.resolve(__dirname, "../apps/api/.env"));
const endpoint = env.API_INTERNAL_URL || `http://127.0.0.1:${env.PORT || 8060}`;
const action = process.argv[2];
// Never put the upload token in argv, URLs, logs or shell command substitutions.
async function main() {
  if (!["on", "off", "check", "drain"].includes(action)) throw new Error("Expected on, off, check or drain.");
  // Updaters use the versioned drain action: older helpers reject it before
  // stopping services instead of silently applying the old media-only check.
  if (action !== "check") {
    const response = await fetch(`${endpoint}/maintenance`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.UPLOAD_API_TOKEN || ""}` },
      body: JSON.stringify({ enabled: action === "on" || action === "drain" })
    });
    if (!response.ok) throw new Error(`Maintenance request failed (${response.status}).`);
  }
  if (action === "off") return;
  const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(10000),
    // Detailed drain counters are available only to the maintenance credential.
    headers: { Authorization: `Bearer ${env.UPLOAD_API_TOKEN || ""}` } });
  if (!response.ok) throw new Error("API health check failed.");
  const { resources } = await response.json();
  // Fail closed against older APIs: an absent counter does not mean zero writes.
  if (!Number.isSafeInteger(resources?.activeWrites) || resources.activeWrites < 0) {
    throw new Error("Upgrade the API to a release with write-drain tracking before using managed maintenance.");
  }
  if (resources.activeWrites || resources.queue.active || resources.queue.pending || resources.videoQueue.active || resources.videoQueue.pending || resources.filmControllers) {
    throw new Error("API writes or media work are still active. Leave maintenance enabled and retry check after it finishes, or turn maintenance off.");
  }
  console.log("No active API writes or media work. Persisted queued film jobs will resume after restart.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
