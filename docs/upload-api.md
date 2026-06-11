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
  -F "video=@D:\multi-master-video-blog\exports\test-video-sdr.mp4" ^
  -F "cover=@D:\multi-master-video-blog\exports\test-cover.jpg" ^
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
