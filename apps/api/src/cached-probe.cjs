// Cache both positive and negative readiness results; share an in-flight probe so
// a public health-check burst cannot create an unbounded number of child processes.
function createCachedProbe(probe, { ttlMs = 60_000, now = Date.now } = {}) {
  let value;
  let expires = 0;
  let pending;
  return async function get() {
    if (expires > now()) return value;
    if (!pending) {
      pending = Promise.resolve().then(probe).then(result => {
        value = result;
        expires = now() + ttlMs;
        return result;
      }).finally(() => { pending = null; });
    }
    return pending;
  };
}

module.exports = { createCachedProbe };
