const { openAsBlob } = require("node:fs");
const { createDirectusTokenCache } = require("./directus-auth.cjs");

/** CMS transport and authentication, independent of HTTP handlers and local service startup. */
function createDirectusClient({ url, email, password, fetch = globalThis.fetch }) {
  const baseUrl = url.replace(/\/$/, "");
  const tokenCache = createDirectusTokenCache({
    login: async () => {
      const response = await directusRequest("/auth/login", null, {
        method: "POST",
        body: { email, password }
      });
      return {
        token: response?.data?.access_token,
        expiresIn: response?.data?.expires
      };
    }
  });

  async function directusLogin() {
    try {
      return await tokenCache.get();
    } catch (error) {
      throw normalizeLoginError(error);
    }
  }

  async function refreshDirectusLogin(failedToken) {
    try {
      return await tokenCache.refresh(failedToken);
    } catch (error) {
      throw normalizeLoginError(error);
    }
  }

  async function directusRequest(pathname, token, options = {}) {
    const { directusAuthRetried = false, ...requestOptions } = options;
    const method = String(requestOptions.method || "GET").toUpperCase();
    let response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        ...requestOptions,
        signal: requestOptions.signal || AbortSignal.timeout(30_000),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(requestOptions.headers || {})
        },
        body: requestOptions.body && typeof requestOptions.body !== "string"
          ? JSON.stringify(requestOptions.body)
          : requestOptions.body
      });
    } catch (cause) {
      throw directusTransportError(method, pathname, cause);
    }

    // Only 401 refreshes credentials; a 403 is a durable permission denial.
    if (token && !directusAuthRetried && response.status === 401) {
      await response.body?.cancel().catch(() => {});
      const refreshedToken = await refreshDirectusLogin(token);
      return directusRequest(pathname, refreshedToken, {
        ...requestOptions,
        directusAuthRetried: true
      });
    }

    return readDirectusResponse(response, method, pathname);
  }

  async function directusUploadFile(token, file, title, options = {}) {
    if (!file) return null;

    // A file-backed Blob streams multipart data without duplicating the image in RAM.
    // Callers retain the immutable temporary file until upload and auth retry finish.
    const blob = await openAsBlob(file.tempPath, {
      type: file.mimeType || "application/octet-stream"
    });
    const reconciliationTag = String(options.reconciliationTag || "").trim();

    async function upload(accessToken, authRetried = false) {
      const form = new FormData();
      if (title) form.append("title", title);
      if (reconciliationTag) form.append("description", reconciliationTag);
      form.append("file", blob, file.filename);

      let response;
      try {
        response = await fetch(`${baseUrl}/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
          signal: AbortSignal.timeout(120_000)
        });
      } catch (cause) {
        throw directusTransportError("POST", "/files", cause);
      }

      if (!authRetried && response.status === 401) {
        await response.body?.cancel().catch(() => {});
        const refreshedToken = await refreshDirectusLogin(accessToken);
        return upload(refreshedToken, true);
      }

      const data = await readDirectusResponse(response, "POST", "/files", "Directus file upload");
      if (typeof data?.data?.id !== "string" || !data.data.id.trim()) {
        throw Object.assign(new Error("Directus file upload response did not include a file id."), {
          statusCode: 502,
          directusRequestSent: true,
          directusResponseStatus: response.status,
          directusAmbiguous: true
        });
      }
      return data.data.id;
    }

    try {
      return await upload(token);
    } catch (error) {
      // A lost success response may hide a committed file. Reconcile before rollback.
      if (error.directusAmbiguous && reconciliationTag) {
        try {
          const fileId = await findDirectusFileByUploadTag(token, reconciliationTag);
          if (fileId) return fileId;
        } catch (reconciliationError) {
          error.reconciliationError = reconciliationError;
        }
      }
      throw error;
    }
  }

  async function findDirectusFileByUploadTag(token, reconciliationTag) {
    const params = new URLSearchParams({
      "filter[description][_eq]": reconciliationTag,
      fields: "id,description",
      limit: "2"
    });
    const response = await directusRequest(`/files?${params}`, token);
    const files = Array.isArray(response.data) ? response.data : [];
    if (files.length > 1) {
      throw Object.assign(new Error(`Multiple Directus files use reconciliation tag ${reconciliationTag}.`), {
        statusCode: 409
      });
    }
    return files[0]?.id == null ? null : String(files[0].id);
  }

  async function fetchDirectusAsset(assetUrl, token, requestHeaders = {}, method = "GET", authRetried = false, signal) {
    const response = await fetch(assetUrl, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(requestHeaders["if-none-match"] ? { "If-None-Match": requestHeaders["if-none-match"] } : {}),
        ...(requestHeaders["if-modified-since"] ? { "If-Modified-Since": requestHeaders["if-modified-since"] } : {})
      }
    });
    if (!authRetried && response.status === 401) {
      await response.body?.cancel().catch(() => {});
      const refreshedToken = await refreshDirectusLogin(token);
      return fetchDirectusAsset(assetUrl, refreshedToken, requestHeaders, method, true, signal);
    }
    return response;
  }

  return { directusLogin, directusRequest, directusUploadFile, findDirectusFileByUploadTag, fetchDirectusAsset };
}

async function readDirectusResponse(response, method, pathname, description = `Directus ${method} ${pathname}`) {
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    // A received HTTP rejection stays definite even if its body is truncated.
    if (!response.ok) throw directusHttpError(response, description, response.statusText, cause);
    const error = directusTransportError(method, pathname, cause);
    error.directusResponseStatus = response.status;
    throw error;
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (cause) {
      if (!response.ok) throw directusHttpError(response, description, text, cause);
      throw Object.assign(new Error(`${description} returned invalid JSON.`), {
        statusCode: 502,
        directusRequestSent: true,
        directusResponseStatus: response.status,
        directusAmbiguous: isDirectusMutationMethod(method),
        cause
      });
    }
  }

  if (!response.ok) {
    throw directusHttpError(response, description, data?.errors?.[0]?.message || text);
  }
  if (!text && method !== "DELETE" && method !== "HEAD") {
    throw Object.assign(new Error(`${description} returned an empty response.`), {
      statusCode: 502,
      directusRequestSent: true,
      directusResponseStatus: response.status,
      directusAmbiguous: isDirectusMutationMethod(method)
    });
  }
  return data;
}

function isDirectusMutationMethod(method) {
  return ["POST", "PATCH", "PUT"].includes(method);
}

function directusTransportError(method, pathname, cause) {
  return Object.assign(new Error(`Directus ${method} ${pathname} did not return a response.`), {
    statusCode: 502,
    directusRequestSent: true,
    directusAmbiguous: isDirectusMutationMethod(method),
    cause
  });
}

function directusHttpError(response, description, message, cause) {
  return Object.assign(new Error(`${description} failed: ${message || response.statusText}`), {
    statusCode: response.status,
    directusHttpStatus: response.status,
    directusRequestSent: true,
    ...(cause ? { cause } : {})
  });
}

function normalizeLoginError(error) {
  if ([401, 403].includes(error.directusHttpStatus || error.statusCode)) {
    return Object.assign(new Error("Directus service authentication failed."), {
      statusCode: 502,
      cause: error
    });
  }
  return error;
}

module.exports = { createDirectusClient };
