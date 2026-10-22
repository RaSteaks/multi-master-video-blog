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

## Resumable browser uploads

The video form uses a durable upload session. Each file is transferred sequentially
in 1 MiB chunks (the final chunk may be shorter); originals are not recompressed.
The API writes chunks to a private disk spool and acknowledges them only after
the bytes and updated offset journal are saved. Receiving uploads does not occupy
an FFmpeg processing slot, including under low-resource profiles.

All routes below require the existing upload token and return `Cache-Control:
no-store`. This is the project's offset/checksum protocol, not a tus endpoint.
Paths below are relative to the public `/api` prefix:

| Method and path | Contract |
| --- | --- |
| `PUT /uploads/video-sessions/:id` | Create with a client-generated UUID v4 and JSON `{fields, files}`. Reusing the ID with identical metadata returns the existing session; different metadata returns 409. |
| `GET /uploads/video-sessions/:id` | Read state, phase, file offsets, retention time and final/partial result. |
| `GET /uploads/video-sessions/:id/files/:index` | Read the confirmed offset and ordered SHA-256 chunk receipts for re-selection verification. |
| `PATCH /uploads/video-sessions/:id/files/:index` | Send `application/octet-stream`, decimal `Upload-Offset`, and hex SHA-256 `Upload-Checksum`. An offset conflict returns 409; invalid length/checksum never advances the offset. |
| `POST /uploads/video-sessions/:id/complete` | Validate that every file is complete and durably enqueue once. Return 202 with the same task on repeated calls, including while processing and after completion. |
| `POST /uploads/video-sessions/:id/cancel` | Cancel a receiving/available queued session; a worker that already owns it returns 409. Retain staged files until their expiration. |

`fields` contains the same string metadata as the legacy multipart form.
`files` is an ordered array of `{field, name, size, type, fingerprint}` entries,
where `field` is `video`, `sdrVideo`, `cover`, or `masterPackage`. Folder names
retain their original relative paths for IMF/HLS resolution; storage filenames
are server-owned. The browser fingerprint hashes the decimal size followed by
the first and last 64 KiB, but is only a selection hint: on resume the client
also checks **every already-confirmed chunk** against the reselected file.
The existing server video/color/package verification still runs before publication.

The browser retries transient network/408/409/429/5xx failures with bounded
exponential backoff and reconciles offsets before resending. It supports pause,
resume and reload recovery. Only the session ID is stored locally, never the
token or video bytes. After reload, enter the token and reselect the original
files when reception is incomplete. If browser storage is unavailable, keep the
displayed task ID for authenticated API lookup. Transfer progress represents
server-confirmed bytes; waiting and processing are separate named states.
The form polls queued/running jobs every 3 seconds, or 15 seconds while hidden.

Sessions transition through `receiving → queued → processing → completed`.
Processing uses the existing bounded media limiter and returns its original
HDR/SDR success or partial-success payload. A full processing queue retains the
uploaded bytes and retries admission. Closing the browser does not cancel a
queued or running job.

After an API restart, receiving sessions keep their confirmed offsets and queued
jobs resume. Processing interrupted **before CMS publication** can restart safely.
The API journals the publication boundary before making CMS writes: a crash or
uncertain failure during those writes becomes `interrupted`, requiring inspection
of the project's existing masters instead of blindly publishing twice. If the
primary master was checkpointed before derivative work, its result is restored
with `processingInterrupted=true`; inspect existing masters before adding SDR.
This is not an exactly-once transaction across the filesystem and Directus.

The private spool defaults to the media directory's sibling
`.private-media/video-uploads`. It must stay outside the public media tree.
Sources and journals are retained for seven days after activity/completion by
default; queued/running jobs do not expire. Cleanup runs every five seconds.
The defaults reserve at most 20 GiB across 32 sessions and allow 8 GiB per session;
`MAX_UPLOAD_BYTES` still limits each source file and the existing image limit
applies to covers. Free disk space is also checked before admission. These bounds
cover the spool, not final source archives, HLS or transcoding output.

Configure `VIDEO_UPLOAD_ROOT`, `VIDEO_UPLOAD_MAX_BYTES`,
`VIDEO_UPLOAD_QUOTA_BYTES`, `VIDEO_UPLOAD_MAX_SESSIONS` and
`VIDEO_UPLOAD_TTL_HOURS` in the API environment. One API process owns a spool,
enforced by a filesystem lock; multiple processes must not share it. An unclean
kill may require up to 30 seconds for the lock to become stale. Container installs
already persist the private-media volume. Separate spool/media mounts are
supported using a file copy when rename cannot cross volumes.

The API's `UPLOAD_REQUEST_TIMEOUT_MS` defaults to 24 hours for legacy multipart
clients, while idle request-body reads expire after 120 seconds. Browser chunk
requests and the Next.js development proxy allow five minutes per chunk.
Nginx templates retain streaming request forwarding, set a 120-second idle body
timeout and reuse upstream connections. Align any additional ingress/CDN limits
with these settings; whole-file legacy uploads still need enough proxy response
time for their upload and processing. No hosting configuration is applied
automatically by changing these example files.

Focused regression checks:

```sh
npm run test:video-upload
```

`tests/video-upload-browser.cjs` exercises the real Next/API/FFmpeg pipeline with
an in-memory CMS, generated SDR video, a throttling proxy and headless WebKit.
It uses only disposable media and loopback ports 13000, 18055, 18060 and 18061.
Provide an installed `playwright` package (or `PLAYWRIGHT_MODULE`), an optional
`WEBKIT_EXECUTABLE`, and usable `FFMPEG_PATH`/`FFPROBE_PATH` when running it on
another machine. Reports, screenshots and the browser trace are retained under
`test-results/video-upload`; no personal browser profile or Chrome is used.

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

### RGB IMF packages

Identification precedes conversion validation. `sourceFormat` in successful or
unsupported-conversion upload responses identifies declared IMF application URIs,
RGB/YCbCr, bit depth, primaries, transfer/range, composition structure and missing
references. SDR/HLG/YCbCr and multi-segment packages can be identified even when
the existing RGB/PQ conversion path rejects them. Missing references mean an
external-reference or incomplete upload, not proof of a valid supplemental IMF.
Resolve preset names and vendor delivery compliance are never inferred.

Dolby evidence is distinguished as linked ISXD declarations, PHDR descriptors
(including a bounded 8 MiB MXF header KLV scan for up to four image assets), or
unlinked Dolby XML sidecars. External MDF inspection recognizes CM4 `dvmd/...`
namespaces and legacy namespace-free CM2.9 roots using version and video structure
within a bounded 64 KiB prefix; frame-wrapped `dvmd-fw/...` remains recognized.
A declaration is not validation of the
per-frame payload. A negative header scan leaves Dolby presence unknown, rather
than claiming its absence. The existing playable HEVC path separately verifies
embedded RPU. These identification paths do not implement Dolby reference
rendering, ISXD/PHDR-to-RPU conversion or full IMF compliance validation.

The bounded `video_masters.source_format` JSON field persists public provenance;
raw source probes and filesystem paths are excluded. Automatic SDR inherits the
original source identity and records whether Dolby metadata was applied to its
conversion. The player's selected output `type`/codec/range remains authoritative
for playback capability checks. Source identity does not upgrade HDR10 to Dolby
Vision. Upload results show source and output separately; the playback page and
Playback Info omit source provenance and source/output comparison sections.

Before deploying this field, run `npm run setup:cms-schema` and ensure the Web
read account can read `video_masters.source_format`. Existing records may be
previewed with `npm run backfill:video-source-formats`, then explicitly updated
with `npm run backfill:video-source-formats -- --apply`. This fills only missing
summaries from saved probe evidence/IMF parents, preserves existing summaries
and playback fields, and does not guess unavailable application or preset data.
Parent provenance is inherited only when source hashes match; an overwritten
parent cannot relabel an older SDR. Run backfill while uploads are paused.
It does not re-encode or re-publish videos. Refresh the video page after the
configured CMS cache interval (or use the existing revalidation flow).

Upload the complete folder as repeated `masterPackage` files with
`sourceKind=master_package`. The API recognizes CPL/ASSETMAP contents and resolves
track files by UUID, including relative paths. Supported compositions have one
segment, one JPEG 2000 RGB image resource, at most one audio resource, no repeats,
and full-range 10/12/16-bit PQ with P3-D65 or BT.2020 primaries. A CPL must declare
component reference levels, display aspect/window, mastering display metadata,
MaxCLL and MaxFALL. Non-square display pixels, missing/ambiguous references,
conflicting stream/CPL metadata, multiple CPLs/segments/resources, split assets,
and unsupported color layouts fail with an actionable `IMF:` error. Export a
flattened composition when those editing features are needed. This is not a full
IMF/PKL compliance or cryptographic asset-hash validator.

For a recognized RGB IMF, the server selects `HDR10 (IMF)` delivery regardless of
the form's master type or copy/transcode selection. It retains the entire source
package in a unique `media/<slug>/source-package/<id>/` directory, including on
overwrite. `file_url` continues to identify the original image MXF; the package
files remain alongside it. The source SHA-256 covers the whole package, so audio
and CPL changes also invalidate stale automatic SDR versions.

The source contract uses CPL-derived RGB matrix/full range and no chroma siting;
YUV validation stays strict. Encoding applies resource entry points/durations,
crops the CPL display window, restores square display pixels, converts P3 to
BT.2020 in linear light, and produces 10-bit limited-range HEVC/AAC MP4 and fMP4
HLS (`VIDEO-RANGE=PQ`). FFmpeg must provide `zscale` and `libx265`. HDR10 output
must preserve the mastering/CLL/FALL values, match the composition's duration,
frame rate and display dimensions, and retain audio before registration. HLS is
then checked against the converted MP4 contract. Partial encodes are removed on
failure; the source package is retained.

Independent Dolby ISXD metadata is **archived, not applied or converted to RPU**.
The result is labeled HDR10, never playable Dolby Vision. The API's
`verification.conversion` reports `intent=imf_rgb_to_hdr10`, the actual filter,
CPL ID, display window and `usesDolbyMetadata=false`. `color-verification.json`
records separate source, converted and output contracts. The normal new-project
SDR workflow runs from the converted, audio-inclusive HDR10 MP4; it requires
libplacebo/Vulkan and does not apply the archived Dolby trims. A supplied SDR
suppresses automatic generation, and existing projects retain the usual append
behavior. SDR failure is reported separately without discarding verified HDR10.

### Paired HDR / SDR and later additions

- The source-video picker accepts one file or two files together. Two embedded sources are sent as two `video` fields; the server identifies exactly one HDR and one SDR from their probed metadata, regardless of order or filename, and infers the HDR master type. Two HDR files, two SDR files, more than two files, or mixing this mode with `sdrVideo`/a package are rejected. Both sources must use copy mode.

- A single HDR upload may include an optional `sdrVideo` file (a browser-deliverable BT.709 MP4/MOV master). Both files use the same project title, slug, description, tags and cover. The SDR is validated before publishing HDR, then packaged in copy mode as an independent manual `SDR` master. It is not an automatic derivative and does not replace an existing master.
- `companionSdr.status=ready|failed` reports the supplied SDR independently. If packaging fails after HDR was saved, HTTP 201 retains the HDR and project; `masters` contains only successfully saved masters. The UI offers an add-SDR link using the returned project ID. Do not resend HDR to recover the missing SDR.
- To add a master later, send `projectId` with the normal source/master fields. Title, slug, description, tags, category, cover and publication state are taken from the existing project and are not modified. `isDefault` defaults to false in this mode. An invalid/deleted ID fails instead of creating another project. Legacy uploads matching an existing slug also reuse its project information.
- `GET /uploads/video-projects` requires the upload bearer token. It accepts `search` and a one-based `page`, returning up to 20 `projects` and `hasMore`. Pass `id` to load a specific project, including an unpublished one. The upload page supports searching, and `/upload?projectId=<id>` opens the add-master flow with SDR selected initially.
- Automatic SDR generation occurs only when the primary is HDR10, HLG or Dolby Vision, no project existed at upload resolution, and no `sdrVideo` was supplied. Supplying an invalid SDR does not silently trigger auto generation. Existing projects do not automatically regenerate or backfill SDR.
- Multipart file limits apply per file. HDR and SDR may have identical filenames; their temporary and saved source paths remain distinct. No upload token is stored in the URL or browser storage.

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

Embedded HDR10, HLG, and Dolby Vision masters must use `mode=copy`. The API rejects arbitrary HDR transcode requests because they can strip HDR metadata, alter primaries, or remove Dolby Vision RPU data. Recognized RGB IMF packages use the dedicated conversion path described above.

The API will package copy-mode uploads as fMP4 HLS under:

```text
media/<slug>/dolby-vision/master.m3u8
```

Directus `video_masters.hls_url` will be:

```text
/media/<slug>/dolby-vision/master.m3u8
```

### Automatic SDR Derivative

New-project HDR uploads without a supplied SDR automatically generate a second, verified SDR master after saving the original. This applies to embedded files, master packages, and verified HLS packages. HDR originals still require `mode=copy`; the internal SDR conversion is a separate operation.

All HDR derivatives require `libplacebo` and working Vulkan, using dynamic peak detection, BT.2390 tone mapping and perceptual gamut mapping. Verified Dolby sources apply embedded RPU metadata. The output is H.264 8-bit BT.709 limited-range video with AAC audio, plus an SDR MP4 download and fMP4 HLS playlist carrying `VIDEO-RANGE=SDR`.

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

These string placeholders represent objects. When automatic conversion is not requested, `sdrDerivative` is `null`. If automatic SDR processing fails, HTTP `201` still confirms that the original was saved, `sdrDerivative` instead contains `status: "failed"`, `error`, and optional `verificationErrors`, and `masters` contains only the original. Clients must inspect that status before reporting that both versions are ready. Supply a manually prepared SDR using the returned project ID; uploading HDR to the now-existing project does not automatically retry conversion. `companionSdr` is null unless a paired SDR was supplied.

`VIDEO_SDR_PROCESS_TIMEOUT_MS` controls the encoding timeout (default `3600000`). Allow enough reverse-proxy time for both upload and processing. The API registers SDR only after conversion and HLS verification succeed.

### Processing capacity

After multipart reception, video uploads share a bounded processing queue. By default,
`VIDEO_PROCESS_CONCURRENCY=1` allows one pipeline (probe, packaging, verification and
optional SDR conversion) at a time. `VIDEO_PROCESS_MAX_PENDING=4` bounds waiting
uploads; `VIDEO_PROCESS_QUEUE_TIMEOUT_MS=60000` bounds their wait. A full or expired
queue returns HTTP `503` and removes temporary uploads; retry the upload later.
`VIDEO_PROCESS_TIMEOUT_MS=3600000` supplies a per-process deadline for ordinary
FFmpeg/FFprobe work. Film-scan and SDR conversion retain their explicit deadlines.
These limits apply to each API process, so account for worker count when deploying.

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

HDR10 requires `smpte2084/PQ`, 10-bit or higher, mastering display metadata, and MaxCLL/MaxFALL. HLG requires `arib-std-b67/HLG` and 10-bit or higher. Dolby Vision requires copy/remux, a supported single-layer embedded configuration, decodable RPU metadata and a nonempty RPU bitstream. Sidecar-only and enhancement-layer sources are rejected. RPU counts/hashes and static HDR metadata must match after packaging.

Successful responses include `colorContract` and `verification`. Failed color checks include `verificationErrors`.

SDR `mode=transcode` accepts tagged SDR inputs (including non-AVC and higher bit
depths), performs explicit color conversion, and validates against the output
BT.709/limited/H.264/yuv420p target. `mode=copy` retains strict source/output equality.
Use matching recent FFmpeg and FFprobe builds: stream flags alone cannot replace
frame-level Dolby metadata parsing. Vulkan availability must be tested under the
same service account used by the upload API.
