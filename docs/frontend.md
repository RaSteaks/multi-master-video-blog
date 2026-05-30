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
NEXT_PUBLIC_DIRECTUS_URL=http://127.0.0.1:8055
```

For production, replace the Directus credentials with a read-only service account and set:

```text
DIRECTUS_SHOW_DRAFTS=false
```

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

Production should let Nginx serve `/media/` directly from `D:/multi-master-video-blog/media/`.

## Verification

```powershell
npm run build:web
```

With Directus, Upload API, and the frontend running:

```text
http://127.0.0.1:3000/videos
http://127.0.0.1:3000/videos/api-upload-test
```
