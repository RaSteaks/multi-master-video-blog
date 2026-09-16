import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import {
  collectRevalidateTags,
  type RevalidateRequest,
} from "@/lib/revalidate-tags";

/**
 * On-demand cache invalidation for Directus webhooks
 * (docs/performance-optimization-plan.md §8).
 *
 *   POST /internal/revalidate
 *   Header: x-revalidate-secret: <REVALIDATE_SECRET>
 *   Body:   { "collection": "posts", "event": "items.update",
 *             "payload": { "id": 1, "slug": "my-post" } }
 *
 * Or a normalized batch:
 *
 *   { "collection": "albums", "items": [{ "slug": "trip-2026" }] }
 *
 * Security posture:
 * - POST only; everything else is 405.
 * - Fails closed: without a configured REVALIDATE_SECRET the endpoint is 503.
 * - Secrets are compared with timingSafeEqual; unauthorized responses do not
 *   reveal whether the secret is configured.
 * - Only the fixed collection→tag mapping in lib/revalidate-tags.ts runs;
 *   request bodies can never name arbitrary tags, paths, or functions.
 *
 * Production Nginx routes /api/* to the Node upload API, so Directus Flows
 * must call this endpoint directly: http://127.0.0.1:3000/internal/revalidate.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    return json({ error: "revalidate endpoint not configured" }, 503);
  }

  const provided = request.headers.get("x-revalidate-secret");
  if (!provided || !secretsMatch(provided, secret)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: RevalidateRequest;
  try {
    body = (await request.json()) as RevalidateRequest;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const tags = collectRevalidateTags(body);
  if (tags.length === 0) {
    // Unknown collection or no usable identifiers: reject loudly so a Flow
    // misconfiguration surfaces instead of silently invalidating nothing.
    return json({ error: "unsupported collection or payload" }, 400);
  }

  for (const tag of tags) {
    revalidateTag(tag, "max");
  }

  console.log(
    `[revalidate] collection=${String(body.collection)} event=${String(
      body.event,
    )} tags=${tags.join(",")}`,
  );

  // Idempotent: replaying a webhook re-invalidates the same tags harmlessly.
  return json({ revalidated: tags });
}

export function GET(): Response {
  return json({ error: "method not allowed" }, 405);
}

export function PUT(): Response {
  return json({ error: "method not allowed" }, 405);
}

export function DELETE(): Response {
  return json({ error: "method not allowed" }, 405);
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
