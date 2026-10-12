function createDirectusTokenCache({
  login,
  now = Date.now,
  safetyMarginMs = 30_000,
  fallbackTtlMs = 5 * 60_000
}) {
  if (typeof login !== "function") {
    throw new TypeError("login must be a function.");
  }

  let cachedToken = null;
  let cachedTokenExpiresAt = 0;
  let pendingLogin = null;

  async function get() {
    if (
      cachedToken &&
      cachedTokenExpiresAt > now() + safetyMarginMs
    ) {
      return cachedToken;
    }

    if (pendingLogin) {
      return pendingLogin;
    }

    const loginAttempt = (async () => {
      const result = await login();
      const token = String(result?.token || "").trim();
      if (!token) {
        throw new Error("Directus login response did not include an access token.");
      }

      const expiresIn = Number(result?.expiresIn);
      cachedToken = token;
      cachedTokenExpiresAt =
        now() +
        (Number.isFinite(expiresIn) && expiresIn > 0
          ? expiresIn
          : fallbackTtlMs);
      return token;
    })();

    pendingLogin = loginAttempt;
    try {
      return await loginAttempt;
    } catch (error) {
      cachedToken = null;
      cachedTokenExpiresAt = 0;
      throw error;
    } finally {
      if (pendingLogin === loginAttempt) {
        pendingLogin = null;
      }
    }
  }

  function invalidate(failedToken = null) {
    if (
      failedToken &&
      cachedToken &&
      String(failedToken) !== String(cachedToken)
    ) {
      return false;
    }
    cachedToken = null;
    cachedTokenExpiresAt = 0;
    return true;
  }

  async function refresh(failedToken) {
    invalidate(failedToken);
    return get();
  }

  function snapshot() {
    return {
      token: cachedToken,
      expiresAt: cachedTokenExpiresAt,
      pending: Boolean(pendingLogin)
    };
  }

  return { get, invalidate, refresh, snapshot };
}

module.exports = { createDirectusTokenCache };
