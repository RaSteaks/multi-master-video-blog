# Upload API

This service accepts video uploads, generates HLS output with FFmpeg, and writes video metadata to Directus.

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

`POST /uploads/videos` expects `multipart/form-data` with a video file field named `video`.
If `UPLOAD_API_TOKEN` is set, include either `Authorization: Bearer <token>` or `X-Upload-Token: <token>`.

Common form fields:

- `video`: required source video file
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

For Dolby Vision, use `mode=copy` so FFmpeg repackages the existing HEVC/Dolby Vision bitstream into fMP4 HLS instead of re-encoding it.
