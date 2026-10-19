# Video Workflow

## Manual HLS Workflow

1. Export video masters from DaVinci Resolve or another editing tool.
2. Create SDR, HDR10, HLG, Dolby Vision, or custom versions as needed.
3. Package each version as HLS without changing the verified color metadata.
4. Copy each HLS folder into the Windows server `media` directory.
5. Create a video project in Directus.
6. Add one video master record per playback version.
7. Publish the project and verify playback on the frontend.

## Example Media URLs

```text
/media/night-city/sdr/master.m3u8
/media/night-city/hdr10/master.m3u8
/media/night-city/hlg/master.m3u8
/media/night-city/dolby-vision/master.m3u8
```

## Metadata Expectations

Every playable master must pass color contract verification before it is published. The upload API stores the verified source and output probe data, then only marks the master as ready when the contract is unchanged.

HDR10, HLG, and Dolby Vision masters must include:

- `codec`
- `color_primaries`
- `color_transfer`
- `matrix_coefficients`
- `color_range`
- `pixel_format`
- `chroma_location`
- `bit_depth`
- `resolution_width`
- `resolution_height`

HDR color primaries may be:

- `bt2020` -> `BT.2020`
- `smpte432` -> `P3-D65(smpte432)`
- `smpte431` -> `DCI-P3(smpte431)`

HDR10 must include mastering display metadata and MaxCLL/MaxFALL. HLG must use `arib-std-b67`. Dolby Vision must contain an embedded configuration and actual decodable RPU; a sidecar alone is not a playable Dolby Vision master.

The player automatically prefers a verified HDR master only when the display and exact codec/range configuration report support. Unknown or unsupported capability falls back to SDR. Manual choices take precedence over pending detection.

The frontend player uses Shaka Player and only exposes masters with `verification_status=ready`.

## Automated Upload Workflow

For automated processing, use the upload API:

```text
POST /api/uploads/videos
```

The backend stores the source file under `media/<slug>/source/`, generates or copies HLS under `media/<slug>/<master-type>/`, verifies the output, and writes `video_projects` plus `video_masters` records to Directus.

The generated HLS root playlist is `master.m3u8`; the media playlist for API-generated packages is `media.m3u8`. The root playlist must include `VIDEO-RANGE=SDR|PQ|HLG`.

HLS declarations are derived from the packaged streams: AVC/HEVC profile, constraints, tier and level come from their decoder configuration/SPS; AAC object types come from AudioSpecificConfig or a recognized probe profile. Video-only masters do not declare audio. Generated HLS selects the first video and optional first audio track; the uploaded source remains intact. Prepackaged HLS retains its rendition groups and rebases their local URIs when the root playlist moves. Every variant and referenced rendition must have nonempty local media files and valid groups before the master becomes ready; unsupported or incomplete codec configurations fail verification. The verification report records each variant's resulting declarations.

For local FFmpeg/ffprobe reads, temporary playlists resolve local references without HTTP cache query parameters; the original playlists are unchanged and the temporary files are removed afterward. HLS-to-SDR conversion reads the root playlist so external audio renditions remain available to the encoder.

Dolby Vision, HDR10, and HLG uploads must use `mode=copy` to avoid stripping or re-encoding color metadata. Prepackaged HLS uploads use `sourceKind=hls_package` and must include a multivariant playlist with `VIDEO-RANGE`.

## Paired Uploads and Automatic HDR SDR Version

Upload HDR with an optional matching SDR file to create two masters with one set of project information. From a video's page, choose "添加视频母版" / "补充 SDR 母版" to add a version later; the upload page also searches existing projects after authentication. Adding a master preserves project information and the existing default unless explicitly changed.

Only new-project HDR10, HLG and Dolby Vision uploads without a supplied SDR attempt automatic SDR conversion. The original HDR stream is copied and verified first; conversion never modifies it. A supplied SDR is kept as a manual master and suppresses automatic conversion.

- All HDR derivatives use `libplacebo` with Vulkan, `peak_detect=true`, `tonemapping=bt.2390`, and `gamut_mode=perceptual`. Peak analysis uses a 20-frame smoothing period with scene-cut thresholds 1/3. Output is BT.709 limited-range 8-bit H.264/AAC; wide-gamut colors are compressed rather than individually clipped. Missing filter/device support fails the derivative and preserves the original; there is no silent fixed-Hable fallback.
- Verified single-layer Dolby Vision Profiles 5 and 8.1/8.4 apply embedded RPU via `apply_dolbyvision=true`. Enhancement-layer/FEL reconstruction and sidecar injection are not supported: those sources must be exported as a supported single-layer delivery master first. This is an adaptive web rendition, not Dolby reference-renderer/trim certification.
- The SDR MP4 and fMP4 HLS are stored in their own versioned directory under `media/<slug>/sdr/`. The generated record has `is_derivative=true`, `derived_from_master_id`, and the conversion filter and intent. Its file URL points to the SDR MP4, while its source probe/hash identify the original master.
- Both the converted MP4 and packaged HLS must pass SDR color checks before registration. The original color-preservation gate remains strict; intentional conversion is recorded separately in `color-verification.json`.
- `isDefault=true` makes an automatically generated SDR the default once it is ready. For paired uploads it applies to the primary HDR master; the supplied SDR is added without changing that default. Later additions default to preserving the existing default. Manually uploaded SDR records are never overwritten by automatic derivatives.
- The upload waits for SDR processing. The form distinguishes file upload from server processing and reports success or partial failure. `VIDEO_SDR_PROCESS_TIMEOUT_MS` bounds encoding (default one hour); proxy timeouts must allow the full upload and processing duration.

The player exposes both verified masters. Manual switches preserve playback position and whether playback was active. If Dolby Vision fails to load or decode, the player automatically selects its paired verified SDR, or another verified SDR if needed. SDR failure stops with a retry action; it cannot loop back to HDR.

If automatic SDR encoding or verification fails, the original HDR remains saved and playable. The upload response includes `sdrDerivative.status=failed` and an error, and no unverified SDR record is published. Add a manually prepared SDR to that project to recover. A supplied SDR that fails after HDR registration instead reports `companionSdr.status=failed`. Existing projects are not automatically retried or retroactively converted.

When an overwrite changes the source hash, the previous automatic SDR is quarantined until regenerated, so playback cannot silently fall back to an older edit.

## Verification contracts

The upload result displays the source master separately from the generated
playback version. The playback page omits this comparison, and Playback Info
shows stream technical details and device capabilities without source provenance.
`source_format` is a bounded public identification
record; it never contains raw probes, archive paths or XML. The player continues
to make capability/fallback decisions from output codec, range and `type`, not
from the original IMF or its Dolby metadata declarations. Declared/unlinked
Dolby metadata is explicitly unvalidated, and conversion-use information is
separate from whether the output contains RPU. Upload source information without
evidence is marked as unrecorded; see `upload-api.md` for schema/backfill rollout.

RGB/PQ IMF folders are an explicit archive-to-delivery exception to copy/remux.
The uploader recognizes CPL/ASSETMAP, resolves image/audio UUIDs and reads full
range, primaries, PQ, display window, edit points and HDR static metadata. It
converts supported single-segment compositions to verified HDR10 HEVC/AAC HLS,
with a separate source/converted/output report and immutable source package.
The upload form and result identify this as HDR10; independent Dolby metadata
is retained only in the archive. Automatic SDR uses the converted HDR10 with
audio. See `upload-api.md` for supported structures, dependencies and limits.

Copy/remux compares dimensions, codec, pixel format, bit depth, primaries, transfer,
matrix, range, chroma location and static HDR metadata values. Dolby verification
requires a supported embedded configuration, decoded frame metadata and actual
RPU NAL payloads. The entire HEVC stream is scanned with bounded memory; RPU count
and SHA-256 must survive packaging unchanged. Each copied video variant is checked.
Frame metadata sampling covers the first 32 packets; RPU hashing covers the full
stream. Sidecar profiles never replace missing stream evidence.

SDR transcoding validates tagged SDR input separately from its BT.709/H.264/8-bit
output target. `zscale` explicitly converts range, matrix, transfer and primaries
in floating point with dithering. Intentional codec/depth changes are permitted;
HDR input must use the HDR upload route rather than being retagged SDR.
Wide-gamut SDR (P3/BT.2020 primaries) uses libplacebo perceptual gamut mapping
without HDR peak detection or inverse tone mapping, instead of clipping via a matrix.

## Automatic playback selection

The display's HDR media query is only a prerequisite, not proof of decoding.
The player reads each candidate HLS variant's exact CODECS (Dolby supplemental
codec where present), VIDEO-RANGE, resolution, frame rate and bandwidth, then
queries MediaCapabilities with gamut and transfer. Native HLS uses `file` checks;
MSE uses `media-source` checks. Unsupported/unknown/unsmooth results or a five-second
selection deadline fall back to verified SDR. Among supported HDR masters, the
explicit HDR default is preferred, followed by Dolby Vision, HDR10 and HLG.
A pending probe cannot override manual selection. Fatal playback errors retain the
paired SDR fallback; an SDR error never loops back to HDR. Reported capability is
not a measurement of monitor calibration, actual luminance or visual fidelity.

## Local verification (2026-10-14)

- API: 122 tests passed, including real Vulkan/libplacebo pixel tests, single-layer
  Profile 5/8 synthetic RPU fixtures, remux hash equality, stripped-RPU rejection,
  static metadata changes, and an independently calculated BT.601-to-BT.709 red patch.
  A subsequent wide-gamut SDR regression also passed, with the two related SDR
  conversion tests rerun after that addition.
- Web: 118 tests passed; TypeScript and production build passed with a disposable CMS.
- Browser: an isolated instance of the actual player confirmed automatic HLG selection
  and that a delayed affirmative HDR capability response cannot override manual SDR.
  Capability responses were controlled test inputs; this does not certify a display.
- GPU execution used local FFmpeg 9.0.2/libplacebo 7.360.1 with MoltenVK on Apple M3 Max.
  Windows was not deployed or modified. Its FFmpeg 8.1.1/Vulkan smoke test was supplied
  separately by the user; service-account and calibrated-display acceptance remain
  deployment checks. Existing unrelated UI static-audit findings were not refactored.
