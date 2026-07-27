const test = require("node:test");
const assert = require("node:assert/strict");
const { createDirectusTokenCache } = require("../src/directus-auth.cjs");

test("Directus token cache deduplicates login and reuses an unexpired token", async () => {
  let loginCount = 0;
  const cache = createDirectusTokenCache({
    login: async () => {
      loginCount += 1;
      return { token: `token-${loginCount}`, expiresIn: 60_000 };
    },
    now: () => 1_000,
    safetyMarginMs: 100
  });

  const [first, second] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(first, "token-1");
  assert.equal(second, "token-1");
  assert.equal(await cache.get(), "token-1");
  assert.equal(loginCount, 1);
});

test("Directus token cache refreshes a failed token without discarding a newer token", async () => {
  let loginCount = 0;
  const cache = createDirectusTokenCache({
    login: async () => {
      loginCount += 1;
      return { token: `token-${loginCount}`, expiresIn: 60_000 };
    },
    now: () => 1_000,
    safetyMarginMs: 100
  });

  assert.equal(await cache.get(), "token-1");
  assert.equal(await cache.refresh("token-1"), "token-2");
  assert.equal(await cache.refresh("token-1"), "token-2");
  assert.equal(loginCount, 2);
});
