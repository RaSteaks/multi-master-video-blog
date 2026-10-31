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

## Development and verification

`src/server.cjs` wires the HTTP handlers and media workflows. CMS transport lives in
`src/directus-client.cjs`, which owns JSON requests, file uploads, asset streaming,
authentication retries, and file-upload reconciliation. It reuses the token cache in
`src/directus-auth.cjs`. Tests can import the client and provide its `fetch` dependency
without starting the API or contacting a real CMS.

JSON requests and file uploads share response parsing: HTTP failures retain the
upstream status even when the error body is HTML or unreadable. A successful POST/PATCH/PUT
with an unreadable, empty, or invalid JSON response remains uncertain and must be
reconciled before its uploaded files can be rolled back.

The root `package.json` declares the runtime requirement. Run the API suite from
the repository root:

```sh
npm run test:api
```

For focused CMS transport checks, run from `apps/api`:

```sh
node --test test/directus-client.test.cjs test/directus-auth.test.cjs
```

The full suite also exercises real media processing and temporary local HTTP servers.
Set `FFMPEG_PATH` and `FFPROBE_PATH` to a matching build that supports the required
codecs and metadata; HDR-to-SDR checks additionally require libplacebo and working
Vulkan. These capabilities are not guaranteed by the bundled static binaries.

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

Exception: complete RGB/PQ IMF folders with CPL and ASSETMAP use a dedicated
JPEG 2000 → HDR10 HEVC/AAC conversion (`zscale` + `libx265`). The API reads CPL
color/range, mastering/CLL/FALL, timing and display-window metadata, joins the
independent audio, and validates the delivery before publishing. Original package
files remain archived. Dolby ISXD metadata is not applied or turned into RPU;
playback is labeled HDR10. New-project uploads can also generate SDR through the
existing libplacebo/Vulkan pipeline. See `docs/upload-api.md` for supported IMF
composition limits and verification/provenance fields.

For Dolby Vision, use `mode=copy` so FFmpeg repackages the existing HEVC/Dolby Vision bitstream into fMP4 HLS instead of re-encoding it. The API rejects Dolby Vision uploads without embedded configuration, decodable RPU and a verified RPU bitstream. Sidecars alone are not accepted.

New-project HDR uploads without a supplied `sdrVideo` automatically generate a separate SDR MP4/HLS master. All HDR derivatives use adaptive `libplacebo`/Vulkan tone and gamut mapping; verified Dolby streams apply embedded RPU. Copy checks retain static metadata and full-stream RPU hashes. Paired uploads report `companionSdr` for the manual SDR; automatic conversion reports `sdrDerivative`. Later uploads use `projectId` to preserve existing project information and do not trigger automatic conversion. See `docs/upload-api.md` for pairing, authenticated project discovery, defaults and partial-failure recovery.

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

Original assets are available at `/api/assets/:id` only when referenced by
published content, site backgrounds, or explicit operator `PUBLIC_ASSET_IDS`
(for local About/branding files without a CMS owner). Authenticated article/video/album previews
use their corresponding publishing token in a header and receive private,
non-cacheable responses; unrelated CMS files remain inaccessible. Public asset
requests recheck publication even when conditional cache headers are present.
Inline article files require service-written provenance in addition to their
Markdown reference; see `docs/deployment.md` for the one-time review of legacy
inline images without provenance. Merely writing another file's ID into a draft
does not grant access to it.
The proxy accepts only
the named presets in `config/directus-asset-presets.json`: `album-cover`,
`album-thumb`, `album-thumb-sm`, `content-card`, `content-hero`,
`site-background`, and `site-background-thumb`, requested with `?key=...`.
Arbitrary width, height, quality, or Sharp transforms are rejected.

Management photos include nullable `width` and `height` from their SDR files,
with EXIF orientation already handled by Directus. Before deploying changed
presets, run `npm run setup:cms-schema` and `npm run test:cms-schema` against
the target CMS; rebuilding the web app does not update Directus settings.
