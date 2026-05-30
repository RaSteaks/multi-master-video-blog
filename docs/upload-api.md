# Upload and HLS Transcoding

The upload API lives in `apps/api`. It accepts a video file plus metadata, generates HLS with FFmpeg, and writes records to Directus.

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

## Upload Example

```powershell
curl.exe -X POST http://127.0.0.1:8060/uploads/videos ^
  -H "Authorization: Bearer local-upload-token" ^
  -F "video=@D:\multi-master-video-blog\exports\test-video-sdr.mp4" ^
  -F "cover=@D:\multi-master-video-blog\exports\test-cover.jpg" ^
  -F "poster=@D:\multi-master-video-blog\exports\test-cover.jpg" ^
  -F "title=Test Video" ^
  -F "slug=test-video" ^
  -F "description=Uploaded from the API" ^
  -F "masterType=sdr" ^
  -F "label=SDR" ^
  -F "published=false" ^
  -F "isDefault=true" ^
  -F "mode=transcode"
```

For Dolby Vision, export a Dolby Vision HEVC master from DaVinci Resolve and upload with:

```text
masterType=dolby_vision
mode=copy
```

The API will package it as fMP4 HLS under:

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
```

Directus records:

```text
video_projects.cover_image
video_projects.poster_image
video_masters.hls_url
video_masters.file_url
```
