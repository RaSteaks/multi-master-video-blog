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

`POST /uploads/videos` expects `multipart/form-data`.
If `UPLOAD_API_TOKEN` is set, include either `Authorization: Bearer <token>` or `X-Upload-Token: <token>`.

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
