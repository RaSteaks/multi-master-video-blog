const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  managedAssetPresets,
  assetPresetMatches,
  assertManagedAssetPresets
} = require("../../../scripts/directus-asset-presets.cjs");

test("schema validation rejects a missing small thumbnail and a legacy padded thumbnail", () => {
  assertManagedAssetPresets(structuredClone(managedAssetPresets));
  assert.throws(
    () => assertManagedAssetPresets(managedAssetPresets.filter((preset) => preset.key !== "album-thumb-sm")),
    /Missing Directus asset preset: album-thumb-sm/
  );
  const legacy = structuredClone(managedAssetPresets);
  Object.assign(legacy.find((preset) => preset.key === "album-thumb"), { width: 720, height: 720, fit: "contain" });
  assert.throws(() => assertManagedAssetPresets(legacy), /Outdated Directus asset preset: album-thumb/);
});

test("setup upgrades legacy presets, preserves custom ones, and is idempotent", async () => {
  // Run the existing updater against stored legacy settings instead of changing a real CMS.
  const source = fs.readFileSync(path.join(__dirname, "../../../scripts/setup-directus-schema.cjs"), "utf8");
  const updater = source.match(/^async function ensureAssetPresets\([\s\S]*?^}/m);
  assert.ok(updater);
  const custom = { key: "custom", width: 100 };
  let settings = { storage_asset_transform: "presets", storage_asset_presets: [
    custom, { key: "album-thumb", fit: "contain", width: 720, height: 720 }
  ] };
  let writes = 0;
  const api = vm.createContext({
    managedAssetPresets, assetPresetMatches, console: { log() {} },
    request: async (pathname, options) => {
      if (options.method === "PATCH") {
        writes++;
        settings = options.body;
        return {};
      }
      return { data: settings };
    }
  });
  vm.runInContext(updater[0], api);
  await api.ensureAssetPresets("test-token");
  assert.equal(writes, 1);
  assertManagedAssetPresets(settings.storage_asset_presets);
  assert.ok(settings.storage_asset_presets.includes(custom));
  await api.ensureAssetPresets("test-token");
  assert.equal(writes, 1);
});
