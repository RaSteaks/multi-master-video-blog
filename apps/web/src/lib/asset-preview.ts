import { authorHeaders, observeAuthorResponse } from "./author-session";

/** Only this fixed same-origin API may receive a publishing credential. */
export function isAssetPreviewUrl(src: unknown): src is string {
  return typeof src === "string" && /^\/api\/assets\/[a-zA-Z0-9-]+(?:\?key=[a-zA-Z0-9-]+)?$/.test(src);
}

export async function fetchAssetPreview(src: string, token: string, signal: AbortSignal) {
  if (!isAssetPreviewUrl(src)) throw new Error("Invalid asset preview request.");
  const response = await fetch(src, {
    headers: authorHeaders(token),
    cache: "no-store",
    redirect: "error",
    signal,
  });
  observeAuthorResponse(response.status, token);
  if (!response.ok) throw new Error("Asset preview unavailable.");
  return response.blob();
}
