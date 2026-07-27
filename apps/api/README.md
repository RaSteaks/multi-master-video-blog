# Upload API

This service accepts video uploads or verified HLS packages, preserves the video color contract, generates or copies HLS output with FFmpeg, verifies the result with FFprobe, and writes video metadata to Directus.

## Local Run

Create `.env` from `.env.example`, then run from the repository root:

```powershell
npm run dev:api
```

Default local URL:

```text
http://127.0.0.1:8060
```

## Endpoints

- `GET /health`
- `POST /uploads/videos`
- `POST /articles`
- `GET /albums/manage`
- `POST /albums`
- `PATCH /albums/:id`
- `POST /albums/:id/photos`
- `PATCH|DELETE /albums/:id/photos/:photoId`
- `POST /albums/:id/photos/reorder`
- `PUT /albums/:id/cover`

`POST /uploads/videos` expects `multipart/form-data`. Configure a long random `UPLOAD_API_TOKEN`, then include either `Authorization: Bearer <token>` or `X-Upload-Token: <token>`. If the token is omitted or still uses the disabled `.env.example` placeholder, video uploading returns HTTP 503 instead of accepting anonymous uploads.

Common form fields:

- `sourceKind`: `embedded`, `master_package`, or `hls_package`
- `video`: required source video file for `sourceKind=embedded`
- `masterPackage`: repeated package files for `sourceKind=master_package` or `sourceKind=hls_package`
- `cover`: optional cover image file
- `title`
- `slug`
- `description`
- `masterType`: `sdr`, `hdr10`, `hlg`, `dolby_vision`, or `custom`
- `label`
- `category`
- `tags`: comma-separated text or JSON array
- `published`: `true` or `false`
- `isDefault`: `true` or `false`
- `mode`: `transcode` or `copy`

Use `mode=copy` by default. HDR10, HLG, and Dolby Vision masters must use `mode=copy`; transcode requests for HDR masters are rejected. HDR primaries are preserved and normalized as `BT.2020`, `P3-D65(smpte432)`, or `DCI-P3(smpte431)`.

For Dolby Vision, use `mode=copy` so FFmpeg repackages the existing HEVC/Dolby Vision bitstream into fMP4 HLS instead of re-encoding it. The API rejects Dolby Vision uploads without embedded DOVI/RPU metadata or a trusted sidecar.

For `sourceKind=hls_package`, include a multivariant `master.m3u8` with `VIDEO-RANGE=SDR|PQ|HLG`. Every variant must share the same color contract.

## Article publishing

The browser-facing URL is `POST /api/articles`; the Next.js and Nginx rewrites forward it to `POST /articles` on this service. The request must use `multipart/form-data` and include `X-Article-Token: <token>` or `Authorization: Bearer <token>`. Generate a long random `ARTICLE_API_TOKEN` on the API service; The `.env.example` value is a deliberately disabled placeholder and must be replaced before use. If `ARTICLE_API_TOKEN` is omitted, the service uses `UPLOAD_API_TOKEN`; if neither token is configured, article publishing is disabled.

Form fields:

- `title` and lowercase-hyphenated `slug`
- `content`: Markdown text
- `category`: optional text
- `tags`: JSON string array
- `published`: `true` creates a published post; omitted or `false` creates a draft
- `articleId`: optional existing `posts.id`; when present, the same endpoint updates that draft/article
- `removeCover`: optional boolean; removes the stored cover during an update when no new `cover` is sent
- `cover`: optional single image file
- `inlineImages`: repeated inline image files
- `inlineImageManifest`: JSON array in the same order as `inlineImages`, with `{ "key", "name", "alt" }` entries

Place `article-image://<key>` in the generated Markdown image form `![alt](article-image://<key>)`. After uploading each image to Directus `/files`, the API replaces only that image target with `/api/assets/<directus-file-id>` before creating or updating the `posts` item. Text inside fenced or inline code is left unchanged. A missing, duplicate, unknown, or unused manifest key rejects the request.

During an update, slug uniqueness checks exclude `articleId`. Without a new `cover`, the existing cover is retained unless `removeCover=true`. Sending both a new `cover` and `removeCover=true` is rejected.

JPEG, PNG, WebP, GIF, and AVIF images are accepted. SVG and MIME/extension or file-signature mismatches are rejected. Defaults are 12 MiB per image, 64 MiB for the complete multipart request, 2 MiB of Markdown, and 24 inline images; the corresponding `MAX_ARTICLE_*` environment variables can lower or raise these limits.

Successful creates return HTTP 201; successful updates return HTTP 200. Both use the same response shape (with `operation` set to `created` or `updated`):

```json
{
  "status": "ok",
  "article": {
    "id": 42,
    "title": "Example",
    "slug": "example",
    "published": false,
    "url": "/posts/example",
    "coverImage": null
  },
  "uploadedImages": [
    {
      "key": "diagram-1",
      "name": "diagram.png",
      "alt": "Diagram",
      "id": "directus-file-uuid",
      "url": "/api/assets/directus-file-uuid"
    }
  ]
}
```

Duplicate slugs return HTTP 409, including Directus unique-constraint responses reported as 400, 409, or 422. Authentication, validation, type, and size errors use 401, 400, 415, and 413 respectively. Directus service-login failures are reported as 502, not as an article-token 401. If a definite image upload or post write failure occurs, the API makes a best-effort rollback of files uploaded by that request. If a POST/PATCH loses its response or returns invalid JSON, the API reads the post back and compares its id/slug, title, content, cover, tags, category, and published state. A confirmed write succeeds; an unconfirmed result returns 502 and retains uploaded files rather than risk deleting assets referenced by a committed article.

## Album management and HDR photos

The browser-facing endpoints use `/api/albums...`; the Next.js and Nginx
rewrites remove `/api` before forwarding to this service. Every album
management request requires `UPLOAD_API_TOKEN` through
`Authorization: Bearer <token>` or `X-Upload-Token`.

`POST /albums/:id/photos` is a `multipart/form-data` request with:

- `manifest`: JSON containing a `photos` array. Every entry has `key`,
  optional `caption`, optional `altText`, and `published`.
- `sdrFiles`: repeated required SDR files.
- `hdrFiles`: repeated optional HDR renditions.

The API pairs files by the case-insensitive filename stem. Duplicate stems,
an HDR file without an SDR partner, an unknown manifest key, or a missing
manifest entry rejects the entire batch. SDR accepts JPEG, PNG, WebP, and
non-HDR AVIF. HDR accepts static AV1 AVIF with PQ or HLG transfer metadata
and exactly 10- or 12-bit samples. File signatures, FFprobe metadata, frame
count, and paired aspect ratios are validated before the first Directus write.

Defaults are 24 photos, 64 MiB per file, and 512 MiB for the complete request.
Override them with `MAX_ALBUM_PHOTOS`, `MAX_ALBUM_IMAGE_BYTES`, and
`MAX_ALBUM_UPLOAD_BYTES`. Album files receive a unique reconciliation tag.
If Directus commits a file or photo but loses the response, the API resolves
the tag and SDR relation before rollback, then removes photo records first and
files second. Photo deletion returns HTTP 202 with `cleanupRequired` and
`orphanFileIds` if the record is gone but one or more file deletions fail.

Original assets are available at `/api/assets/:id`. The proxy accepts only
the named query presets `?key=album-cover` and `?key=album-thumb`; arbitrary
width, height, quality, or Sharp transforms are rejected.
