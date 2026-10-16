const { sourceFormatFromProbe, sourceFormatForPlayback, sanitizeSourceFormat } = require("../shared/video-source-format.cjs");

const object = value => {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try { return JSON.parse(value); } catch { return {}; }
};

function sourceFormatPatches(records) {
  const byId = new Map(records.map(row => [String(row.id), row]));
  function source(row, seen = new Set()) {
    if (!row || seen.has(String(row.id)) || seen.size >= 32) return null;
    seen.add(String(row.id));
    const current = sanitizeSourceFormat(object(row.source_format));
    if (current) return current;
    const parent = row.derived_from_master_id ? byId.get(String(row.derived_from_master_id)) : null;
    // An SDR record may describe its HDR intermediate, so prefer known IMF provenance.
    const ancestor = parent ? source(parent, seen) : null;
    const ownSource = sourceFormatFromProbe(object(row.source_probe_json));
    if (ownSource?.container === "imf") return ownSource;
    if (ancestor?.container === "imf") {
      // An overwritten parent ID can point to a different edit. Only matching
      // source hashes establish that its provenance belongs to this derivative.
      return row.source_sha256 && row.source_sha256 === parent.source_sha256 ? ancestor : null;
    }
    return ownSource;
  }
  return records.filter(row => !sanitizeSourceFormat(object(row.source_format))).flatMap(row => {
    const summary = source(row);
    if (!summary) return [];
    const output = object(row.output_probe_json);
    const dovi = (Array.isArray(output.side_data_list) ? output.side_data_list : []).find(item => /dovi configuration/i.test(item.side_data_type || ""));
    const outputContract = row.verification_status === "ready" ? { dolbyMetadata: { profile: dovi?.dv_profile, rpuPresent: Boolean(dovi?.rpu_present_flag) } } : {};
    return [{ id: row.id, source_format: sourceFormatForPlayback(summary, outputContract) }];
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--apply", "--dry-run"].includes(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) {
    throw new Error("Usage: node scripts/backfill-video-source-formats.cjs [--dry-run | --apply]");
  }
  // Preview by default. Explicit --apply is the only path that writes CMS data.
  const apply = args.includes("--apply");
  const env = require("./directus-db-utils.cjs").loadDirectusEnv(process.env.DIRECTUS_ENV_PATH);
  const base = String(env.DIRECTUS_URL || env.PUBLIC_URL || `http://${env.HOST || "127.0.0.1"}:${env.PORT || 8055}`).replace(/\/$/, "");
  let token;
  async function request(url, options = {}) {
    const response = await fetch(base + url, {
      ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`CMS ${options.method || "GET"} failed (${response.status}). Run setup:cms-schema first and check account permissions.`);
    return response.status === 204 ? null : response.json();
  }
  token = (await request("/auth/login", { method: "POST", body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) })).data.access_token;
  const rows = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ fields: "id,source_format,source_probe_json,output_probe_json,derived_from_master_id,verification_status,source_sha256", sort: "id", limit: "100", page: String(page) });
    const data = (await request(`/items/video_masters?${params}`)).data;
    rows.push(...data);
    if (data.length < 100) break;
  }
  const patches = sourceFormatPatches(rows);
  let updated = 0;
  for (const patch of patches) {
    if (apply) {
      const current = (await request(`/items/video_masters/${encodeURIComponent(patch.id)}?fields=id,source_format,source_sha256`)).data;
      const original = rows.find(row => String(row.id) === String(patch.id));
      // Do not overwrite a newly enriched/replaced master observed since the preview query.
      if (!current || sanitizeSourceFormat(object(current.source_format)) || current.source_sha256 !== original.source_sha256) {
        console.log(JSON.stringify({ id: patch.id, action: "skipped_changed_record" }));
        continue;
      }
      await request(`/items/video_masters/${encodeURIComponent(patch.id)}`, { method: "PATCH", body: JSON.stringify({ source_format: patch.source_format }) });
      updated++;
    }
    console.log(JSON.stringify({ id: patch.id, action: apply ? "updated" : "would_update", source: patch.source_format }));
  }
  console.log(`${apply ? updated : patches.length} records ${apply ? "updated" : "previewed"}; existing source_format values and playback fields were preserved.`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { sourceFormatPatches };
