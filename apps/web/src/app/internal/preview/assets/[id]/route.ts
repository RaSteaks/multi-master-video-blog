import { fetchDirectusPreview } from "@/lib/directus";
import { assetUrl, type AssetPreset } from "@/lib/asset-url";
import { canReadAsset } from "../../../../../../../api/src/asset-access.cjs";
import { assetSafetyHeaders } from "../../../../../../../api/src/media-security.cjs";

export const dynamic = "force-dynamic";

/** Only the existing explicit draft-site mode can expose referenced draft images. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const hidden = () => new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  if (process.env.DIRECTUS_SHOW_DRAFTS !== "true") return hidden();
  const { id } = await params;
  const url = new URL(request.url);
  if (!/^[a-zA-Z0-9-]+$/.test(id) || url.searchParams.getAll("key").length > 1 ||
      [...url.searchParams.keys()].some(key => key !== "key")) return hidden();
  let upstreamPath: string;
  try {
    // Reuse the public preset allowlist; arbitrary transforms remain unavailable.
    upstreamPath = assetUrl(id, (url.searchParams.get("key") || undefined) as AssetPreset)!.replace(/^\/api/, "");
  } catch { return hidden(); }
  try {
    const allowed = await canReadAsset(id, { preview: true }, async (route: string) => {
      const response = await fetchDirectusPreview(route);
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error("Preview lookup failed."), { statusCode: response.status });
      }
      return response.json();
    });
    // Manually declared public branding assets are owned by the API configuration.
    // Fall back only as an anonymous caller; never forward CMS credentials to that path.
    const response = allowed ? await fetchDirectusPreview(upstreamPath)
      : await fetch(`http://127.0.0.1:8060${upstreamPath}`, {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
    if (!response.ok) { await response.body?.cancel(); return hidden(); }
    const type = response.headers.get("content-type") || "application/octet-stream";
    return new Response(response.body, { headers: {
      "Content-Type": type, "Cache-Control": "private, no-store", ...assetSafetyHeaders(type),
    } });
  } catch {
    return new Response(null, { status: 502, headers: { "Cache-Control": "private, no-store" } });
  }
}
