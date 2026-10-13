# Upload and HLS Packaging

The upload API lives in `apps/api`. It accepts a source master or verified HLS package, preserves the video color contract, generates or copies HLS, verifies the output with FFprobe, and writes records to Directus.

## Services

```text
Frontend: 127.0.0.1:3000
Directus: 127.0.0.1:8055
Upload API: 127.0.0.1:8060
```

Nginx should expose the API through:

```text
/api/ -> 127.0.0.1:8060
```

Do not expose `8060` directly to the public internet.

## Requirements

The project uses npm-provided `ffmpeg-static` and `ffprobe-static` by default. For production, you can install FFmpeg yourself and set absolute paths in `apps/api/.env`:

```text
FFMPEG_PATH=C:/path/to/ffmpeg.exe
FFPROBE_PATH=C:/path/to/ffprobe.exe
```

## Local Commands

```powershell
npm run dev:api
npm run test:api
```

Health check:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8060/health
```

Local development media files can also be served through the API:

```text
http://127.0.0.1:8060/media/<slug>/<master-type>/master.m3u8
```

The Next.js dev server rewrites `/media/*` to the upload API so local playback works at `http://127.0.0.1:3000`.

## Upload Authentication

Set `UPLOAD_API_TOKEN` in `apps/api/.env`.

The Service Manager at `/manager/` provides an **Upload tokens** panel for
rotating both managed credentials:

- **Video & albums** updates `UPLOAD_API_TOKEN`, used by video uploads, album
  management, photo uploads, and film-scan jobs.
- **Articles** updates `ARTICLE_API_TOKEN`, or can intentionally share the
  video and album token.

Existing token text is never sent back to the manager page. The page shows a
one-way fingerprint for identification, and saving automatically restarts the
Upload API so the new values take effect. Protect `/manager/` with manager
authentication and/or the Nginx access controls described in the deployment
configuration.

Upload requests must include one of:

```text
Authorization: Bearer <token>
X-Upload-Token: <token>
```

Do not expose `127.0.0.1:8060` directly. Public access should go through Nginx `/api/`.

## Upload Sources

Use one of:

- `sourceKind=embedded` with a video file field named `video`
- `sourceKind=master_package` with folder files named `masterPackage`
- `sourceKind=hls_package` with folder files named `masterPackage`

`sourceKind=hls_package` must include a multivariant `master.m3u8` with `VIDEO-RANGE=SDR|PQ|HLG`. All variants must share the same verified color contract.

## Upload Example

```powershell
curl.exe -X POST http://127.0.0.1:8060/uploads/videos ^
  -H "Authorization: Bearer local-upload-token" ^
  -F "video=@D:\path\to\exports\test-video-sdr.mp4" ^
  -F "cover=@D:\path\to\exports\test-cover.jpg" ^
  -F "title=Test Video" ^
  -F "slug=test-video" ^
  -F "description=Uploaded from the API" ^
  -F "masterType=sdr" ^
  -F "label=SDR" ^
  -F "published=false" ^
  -F "isDefault=true" ^
  -F "mode=copy"
```

For Dolby Vision, export a Dolby Vision HEVC master from DaVinci Resolve and upload with:

```text
masterType=dolby_vision
mode=copy
```

HDR10, HLG, and Dolby Vision masters must use `mode=copy`. The API rejects HDR transcode requests because they can strip HDR metadata, alter primaries, or remove Dolby Vision RPU data.

The API will package copy-mode uploads as fMP4 HLS under:

```text
media/<slug>/dolby-vision/master.m3u8
```

Directus `video_masters.hls_url` will be:

```text
/media/<slug>/dolby-vision/master.m3u8
```

### Automatic SDR Derivative

Dolby Vision uploads automatically generate a second, verified SDR master after saving the original. This applies to embedded files, master packages, and verified HLS packages (using the inspected primary media variant). Original Dolby Vision uploads still require `mode=copy`; the internal SDR conversion is a separate operation.

P8.4/HLG and PQ-compatible sources are tone-mapped using `zscale` and `tonemap`, without applying RPU metadata. Profile 5 requires embedded RPU metadata, `libplacebo`, and working Vulkan support. The output is H.264 8-bit BT.709 limited-range video with AAC audio, plus an SDR MP4 download and fMP4 HLS playlist carrying `VIDEO-RANGE=SDR`.

For Dolby Vision requests, `isDefault=true` makes the generated SDR the default after successful conversion. With `isDefault=false`, the existing default is preserved; an SDR default is assigned if none exists. Automatic derivatives are identified by source master ID and conversion intent, so a manually uploaded SDR with the same label is preserved.

Responses retain the existing `master`, `hlsUrl`, `probe`, and `verification` fields for the original master, and add:

```json
{
  "masters": ["<original master record>", "<SDR master record>"],
  "sdrDerivative": {
    "status": "ready",
    "master": "<SDR master record>",
    "hlsUrl": "/media/<slug>/sdr/<version>/master.m3u8",
    "fileUrl": "/media/<slug>/sdr/<version>/sdr.mp4",
    "colorContract": "<verified SDR color contract>",
    "verification": "<SDR verification and conversion details>"
  }
}
```

These string placeholders represent objects. For non-Dolby uploads, `sdrDerivative` is `null` and `masters` contains only the uploaded master. If automatic SDR processing fails, HTTP `201` still confirms that the original was saved, `sdrDerivative` instead contains `status: "failed"`, `error`, and optional `verificationErrors`, and `masters` contains only the original. Clients must inspect that status before reporting that both versions are ready. Retry with `overwrite=true` after resolving the failure; existing uploads are not backfilled automatically.

`VIDEO_SDR_PROCESS_TIMEOUT_MS` controls the encoding timeout (default `3600000`). Allow enough reverse-proxy time for both upload and processing. The API registers SDR only after conversion and HLS verification succeed.

## Stored Output

Source video:

```text
media/<slug>/source/<uploaded-file>
```

HLS:

```text
media/<slug>/<master-type>/master.m3u8
media/<slug>/<master-type>/media.m3u8
```

Directus records:

```text
video_projects.cover_image
video_masters.hls_url
video_masters.file_url
```

## Color Contract Gate

The API hard-fails with HTTP `422` when the source or output color contract is incomplete or changes during packaging.

Required verified fields:

- `color_primaries`
- `color_transfer`
- `matrix_coefficients`
- `color_range`
- `pixel_format`
- `bit_depth`
- `chroma_location`
- `hls_video_range`

HDR primaries are normalized as:

- `bt2020` -> `BT.2020`
- `smpte432` -> `P3-D65(smpte432)`
- `smpte431` -> `DCI-P3(smpte431)`

HDR10 requires `smpte2084/PQ`, 10-bit or higher, mastering display metadata, and MaxCLL/MaxFALL. HLG requires `arib-std-b67/HLG` and 10-bit or higher. Dolby Vision requires copy/remux plus embedded DOVI/RPU metadata or a trusted sidecar.

Successful responses include `colorContract` and `verification`. Failed color checks include `verificationErrors`.
