# Frontend

The frontend lives in `apps/web` and uses Next.js server components to read Directus content.

## Routes

```text
/                  Home with latest videos and posts
/videos            Video project list
/videos/[slug]     Video detail page with HLS player and master switching
/posts             Article list
/posts/[slug]      Markdown article detail
/about             About page
```

## Environment

Local development uses `apps/web/.env.local`:

```text
DIRECTUS_URL=http://127.0.0.1:8055
DIRECTUS_EMAIL=admin@example.com
DIRECTUS_PASSWORD=change-this-local-password
DIRECTUS_SHOW_DRAFTS=true
DIRECTUS_REVALIDATE=0
NEXT_PUBLIC_DIRECTUS_URL=http://127.0.0.1:8055
```

For production, replace the Directus credentials with a read-only service account and set:

```text
DIRECTUS_SHOW_DRAFTS=false
DIRECTUS_REVALIDATE=30
```

## Data Cache and on-demand invalidation

Three cache layers are involved and must not be conflated:

1. **Next Data Cache** — `DIRECTUS_REVALIDATE > 0` puts Directus GET responses into
   the data cache with a time-based TTL. This is the primary latency win.
2. **Full Route Cache** — only static-compatible routes are prerendered. Routes
   that read `searchParams` (e.g. `/albums`) or opt into `force-dynamic`
   (e.g. `/about`) stay server-rendered on demand even with Data Cache enabled.
3. **Browser asset cache** — served images (`/api/assets/*`) and `/media/*` are
   cached by the browser per response headers; unrelated to the two layers above.

Production values live in `apps/web/.env.production.local` (loaded by
`next start`, ignored by `next dev`, never committed). Development keeps
`DIRECTUS_REVALIDATE=0` in `.env.local` so content edits appear immediately.

When `REVALIDATE_SECRET` is set, Directus webhooks can POST to
`/internal/revalidate` to drop tagged cache entries on content change
(collection allowlist: `posts`, `video_projects`, `albums`, `album_photos`,
`site_settings`). Directus Flows should call `http://127.0.0.1:3000/internal/revalidate`
directly — production Nginx routes `/api/*` to the Node upload API, so the
public path does not reach Next route handlers.

## Media Playback

The player uses Shaka Player for browser HLS playback and can switch between configured video masters while preserving the current playback time.

Implemented player behavior:

- HLS playback
- SDR / HDR10 / HLG / Dolby Vision / custom master switching
- Current time preservation during master switching
- Fatal playback error fallback to SDR when available
- Technical metadata display
- HDR display, P3, Rec.2020, HEVC, and native HLS capability hints
- fMP4 HLS playback path for Dolby Vision uploads

In local development, Next.js rewrites:

```text
/media/* -> http://127.0.0.1:8060/media/*
```

Production should let Nginx serve `/media/` directly from `D:/path/to/media/`.

## Verification

```powershell
npm run build:web
```

With Directus, Upload API, and the frontend running:

```text
http://127.0.0.1:3000/videos
http://127.0.0.1:3000/videos/api-upload-test
```

## Appearance preferences

The appearance panel opens on **Background**, to the left of **Color**. Liquid
backgrounds share one browser-local palette across all routes, independently of
the global accent. The original video gray (`#121518`, three gray blobs) is the
default. HSV only changes the flowing blobs, deriving their colors with 35%, 30%,
and 32% white mixes. The surround stays dark gray (`#121518`) for every selection,
including saved colors restored on startup. The speed range is 0–3× in 0.1 steps; 0 pauses, and 1× retains the
original 20/23/22-second cycles. Reduced-motion preferences take precedence.

The collapsible HSV editor is shared with the theme editor. Five custom slots
support saving, applying, overwriting, clearing, and undoing the last slot edit.
The separate default-gray swatch cannot be overwritten. Restoring the background
defaults resets mode/image/blur, liquid color and speed, while keeping saved slots.

`mm-liquid-background-v1` stores `{ version: 1, speed, color, slots }` in
localStorage. Colors are `{ kind: "gray" }` or `{ kind: "custom", hsv: { h, s, v } }`;
slots contain exactly five colors or null entries. Startup and client updates
share validation/palette code; storage events synchronize tabs without write-back.
Blocked storage keeps changes in memory and displays a persistence error. No CMS
fields or account synchronization are involved. See the root `DESIGN.md` for
runtime token ownership.
