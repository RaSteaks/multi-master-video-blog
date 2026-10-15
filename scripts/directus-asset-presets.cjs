// The web srcset, API allowlist, setup and schema check share the same preset contract.
const managedAssetPresets = require("../config/directus-asset-presets.json");

function assetPresetMatches(current, expected) {
  return Object.entries(expected).every(
    ([key, value]) => current?.[key] === value
  );
}

function assertManagedAssetPresets(currentPresets) {
  for (const expected of managedAssetPresets) {
    const current = currentPresets.find((preset) => preset?.key === expected.key);
    if (!current) {
      throw new Error(`Missing Directus asset preset: ${expected.key}`);
    }
    // A present key with old padding or dimensions still breaks width-descriptor srcsets.
    if (!assetPresetMatches(current, expected)) {
      throw new Error(
        `Outdated Directus asset preset: ${expected.key}. Run npm run setup:cms-schema.`
      );
    }
  }
}

module.exports = { managedAssetPresets, assetPresetMatches, assertManagedAssetPresets };
