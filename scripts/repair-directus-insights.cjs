const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { loadDirectusEnv } = require("./directus-db-utils.cjs");

const aggregations = new Set([
  "count", "countDistinct", "avg", "avgDistinct", "sum", "sumDistinct", "min", "max"
]);
const panelFields = "id,name,type,dashboard,options";
const usage = "npm run repair:cms-insights -- [--panel-id ID --aggregation count] [--apply] [--backup-dir PATH]";

async function repairInsightsAggregation({ env, panelId, aggregation, apply = false, backupDir = path.resolve("backups", "directus-insights") }) {
  if (aggregation && !aggregations.has(aggregation)) {
    throw new Error(`Unsupported aggregation. Choose: ${[...aggregations].join(", ")}.`);
  }
  if ((aggregation && !panelId) || (apply && (!panelId || !aggregation))) {
    throw new Error(`Applying a repair requires one --panel-id and an explicit --aggregation. Usage: ${usage}`);
  }
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    throw new Error("Configure ADMIN_EMAIL and ADMIN_PASSWORD in the deployed CMS environment.");
  }
  const base = String(env.DIRECTUS_URL || env.PUBLIC_URL || `http://127.0.0.1:${env.PORT || 8055}`).replace(/\/$/, "");
  let token;
  async function request(route, method = "GET", body) {
    const response = await fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000)
    });
    const json = await response.json();
    if (!response.ok || json.errors?.length) {
      const message = json.errors?.[0]?.extensions?.errors?.[0]?.message || json.errors?.[0]?.message || response.statusText;
      throw new Error(`Directus ${method} ${route} failed (${response.status}): ${message}`);
    }
    return json.data;
  }
  const login = await request("/auth/login", "POST", { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
  if (typeof login?.access_token !== "string") throw new Error("Directus login returned no access token.");
  token = login.access_token;

  const route = panelId ? `/panels/${encodeURIComponent(panelId)}?fields=${panelFields}` : `/panels?fields=${panelFields}&limit=-1`;
  const data = await request(route);
  if (!panelId && !Array.isArray(data)) throw new Error("Directus returned an invalid panel list.");
  const panels = (panelId ? [data] : data).map(readPanel);
  if (panelId && panels[0].type !== "line-chart") {
    throw new Error("This repair targets line-chart panels whose aggregation becomes undefined.");
  }
  const affected = panels.filter(panel => panel.type === "line-chart" && !aggregations.has(panel.options.aggregation));
  const result = {
    mode: apply ? "apply" : "preview",
    panels: affected.map(panel => ({
      id: panel.id, name: panel.name, dashboard: panel.dashboard,
      collection: panel.options.collection, xAxis: panel.options.xAxis, yAxis: panel.options.yAxis,
      currentAggregation: panel.options.aggregation ?? null,
      proposedAggregation: aggregation ?? null
    }))
  };
  if (!apply || affected.length === 0) return { ...result, updated: 0 };

  const panel = affected[0];
  const collection = panel.options.collection;
  const field = panel.options.yAxis;
  // These identifiers enter GraphQL source; reject malformed names at the API boundary.
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (typeof collection !== "string" || !identifier.test(collection) || typeof field !== "string" || !identifier.test(field)) {
    throw new Error("Set a valid collection and Y axis field in the panel before repairing its aggregation.");
  }
  // Validate the chosen function against the deployed schema before saving any configuration.
  await request("/graphql", "POST", { query: `query { ${collection}_aggregated { ${aggregation} { ${field} } } }` });
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${encodeURIComponent(panel.id)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(backupPath, JSON.stringify(panel, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  // Directus replaces the options object, so retain filters, axes and display settings.
  await request(`/panels/${encodeURIComponent(panel.id)}`, "PATCH", { options: { ...panel.options, aggregation } });
  const saved = readPanel(await request(`/panels/${encodeURIComponent(panel.id)}?fields=${panelFields}`));
  if (saved.options.aggregation !== aggregation) throw new Error(`Panel repair was not persisted. Original options: ${backupPath}`);
  return { ...result, updated: 1, backupPath, graphqlVerified: true };
}

function readPanel(panel) {
  if (!panel || typeof panel.id !== "string" || typeof panel.type !== "string" ||
    (panel.options != null && (typeof panel.options !== "object" || Array.isArray(panel.options)))) {
    throw new Error("Directus returned an invalid panel configuration.");
  }
  return { ...panel, options: panel.options ?? {} };
}

async function main() {
  const args = parseArgs({ options: {
    "panel-id": { type: "string" }, aggregation: { type: "string" },
    apply: { type: "boolean" }, "backup-dir": { type: "string" }, help: { type: "boolean" }
  } });
  if (args.values.help) { console.log(usage); return; }
  const result = await repairInsightsAggregation({
    env: loadDirectusEnv(process.env.DIRECTUS_ENV_PATH),
    panelId: args.values["panel-id"], aggregation: args.values.aggregation,
    apply: args.values.apply, backupDir: args.values["backup-dir"]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { repairInsightsAggregation };
