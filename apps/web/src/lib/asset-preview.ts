import { authorHeaders, observeAuthorResponse } from "./author-session";

/** Only this fixed same-origin API may receive a publishing credential. */
export function isAssetPreviewUrl(src: unknown): src is string {
  return typeof src === "string" && /^\/api\/assets\/[a-zA-Z0-9-]+(?:\?key=[a-zA-Z0-9-]+)?$/.test(src);
}

/** Share active downloads only; private blobs and credentials never enter persistent storage. */
export function createAssetPreviewLoader({
  request = fetch,
  headersFor = authorHeaders,
  observeResponse = observeAuthorResponse,
}: {
  request?: typeof fetch;
  headersFor?: typeof authorHeaders;
  observeResponse?: typeof observeAuthorResponse;
} = {}) {
  const pending = new Map<string, { controller: AbortController; promise: Promise<Blob>; consumers: number }>();

  return async (src: string, token: string, signal: AbortSignal) => {
    if (!isAssetPreviewUrl(src)) throw new Error("Invalid asset preview request.");
    signal.throwIfAborted();
    // Resolve credentials per caller: a changed session/CSRF nonce must not join an old request.
    const headers = headersFor(token);
    const key = JSON.stringify([src, headers]);
    let entry = pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = (async () => {
        const response = await request(src, { headers, cache: "no-store", redirect: "error", signal: controller.signal });
        observeResponse(response.status, token);
        if (!response.ok) throw new Error("Asset preview unavailable.");
        return response.blob();
      })();
      entry = { controller, promise, consumers: 0 };
      pending.set(key, entry);
      const current = entry;
      const forget = () => { if (pending.get(key) === current) pending.delete(key); };
      // Remove failures as well as successes so retry always makes a fresh authorized request.
      void promise.then(forget, forget);
    }
    const current = entry;
    current.consumers++;
    return new Promise<Blob>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal.removeEventListener("abort", abort);
        current.consumers--;
        if (current.consumers === 0 && pending.get(key) === current) {
          pending.delete(key);
          current.controller.abort();
        }
      };
      // One image unmounting must not abort another image using the same download.
      const abort = () => { release(); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      current.promise.then(blob => { release(); resolve(blob); }, error => { release(); reject(error); });
    });
  };
}

export const fetchAssetPreview = createAssetPreviewLoader();
