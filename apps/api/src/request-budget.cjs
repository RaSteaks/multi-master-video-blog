const { isIP } = require("node:net");

/** Fixed-size admission state: rotating identities cannot bypass the global budget. */
function createRequestBudget({ limit, perClient = limit, windowMs = 60_000, maxClients = 2048, now = Date.now }) {
  let started = now(), total = 0;
  const clients = new Map();
  return {
    consume(key = "anonymous") {
      const time = now();
      if (time - started >= windowMs) { started = time; total = 0; clients.clear(); }
      if (total >= limit || (clients.get(key) || 0) >= perClient || (!clients.has(key) && clients.size >= maxClients)) {
        throw Object.assign(new Error("Too many requests. Please retry later."), { statusCode: 429 });
      }
      total++; clients.set(key, (clients.get(key) || 0) + 1);
    }
  };
}

/** Only an explicitly trusted reverse proxy may supply the overwritten X-Real-IP. */
function requestAddress(req, trustProxy = false) {
  const forwarded = req.headers["x-real-ip"];
  return trustProxy && typeof forwarded === "string" && isIP(forwarded)
    ? forwarded : req.socket?.remoteAddress || "unknown";
}

module.exports = { createRequestBudget, requestAddress };
