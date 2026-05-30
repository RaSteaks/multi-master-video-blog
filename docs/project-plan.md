# Project Plan

## Goal

Build a self-hosted Windows media blog that supports articles, video projects, HLS playback, and switching between SDR, HDR10, HLG, Dolby Vision, and custom video masters.

## Recommended Stack

- Frontend: Next.js, TypeScript, Tailwind CSS later if needed
- Player: Shaka Player or Video.js
- CMS: Directus
- Development database: SQLite
- Production database: PostgreSQL
- Deployment: Windows server, Node.js LTS, existing Nginx, HTTPS

## Core Data Models

### Post

- `id`
- `title`
- `slug`
- `summary`
- `content`
- `cover_image`
- `tags`
- `category`
- `published`
- `created_at`
- `updated_at`

### Video Project

- `id`
- `title`
- `slug`
- `description`
- `cover_image`
- `poster_image`
- `category`
- `tags`
- `published`
- `sort_order`
- `created_at`
- `updated_at`

### Video Master

- `id`
- `project_id`
- `label`
- `type`
- `hls_url`
- `file_url`
- `codec`
- `resolution_width`
- `resolution_height`
- `color_space`
- `transfer_function`
- `bit_depth`
- `bitrate_mbps`
- `is_default`
- `sort_order`
- `status`
- `uploaded_at`
- `notes`
- `created_at`
- `updated_at`

## Rules

- Slugs use lowercase English letters, numbers, and hyphens only.
- Store browser-accessible URLs in the database, not Windows absolute disk paths.
- Every video project must have at least one video master.
- Every video project must have exactly one default video master.
- Default masters should usually be SDR.
- HLS URLs must point to `master.m3u8`.
- Large video files stay out of Git.

## Implemented CMS Schema

The Directus schema can be created or repaired with:

```powershell
npm run setup:cms-schema
```

Verify it with:

```powershell
npm run test:cms-schema
npm run test:cms-crud
```

Current implemented collections:

- `posts`
- `video_projects`
- `video_masters`

Current implemented relations:

- `posts.cover_image` -> `directus_files`
- `video_projects.cover_image` -> `directus_files`
- `video_projects.poster_image` -> `directus_files`
- `video_masters.project_id` -> `video_projects.id`
- `video_projects.masters` provides the one-to-many editing alias for video masters.

## Implemented Frontend Pages

- `/`
- `/videos`
- `/videos/[slug]`
- `/posts`
- `/posts/[slug]`
- `/about`

The video detail page includes an HLS player with video master switching.

## Implemented Player Stage

The fourth-stage player is implemented with Shaka Player.

Current behavior:

- Loads HLS playlists from `video_masters.hls_url`
- Switches between configured masters
- Preserves current playback time when switching
- Falls back to SDR after a fatal playback failure when an SDR master exists
- Shows current master metadata
- Shows client capability hints for HDR, color gamut, HEVC, and native HLS

## Implemented Upload and Deployment Stage

- Upload API accepts source video plus metadata.
- Upload API can receive optional `cover` and `poster` image files and upload them to Directus.
- Upload API generates HLS with FFmpeg.
- Upload API requires `UPLOAD_API_TOKEN` when configured.
- Local Windows service scripts are available in `deployment/windows/`.
- `npm run health` verifies frontend, Directus, upload API, and test HLS availability.
