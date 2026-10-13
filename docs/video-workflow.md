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

HDR10 must include mastering display metadata and MaxCLL/MaxFALL. HLG must use `arib-std-b67`. Dolby Vision must retain embedded DOVI/RPU metadata or a trusted sidecar.

The frontend player should default to SDR and let users manually switch to HDR-capable versions.

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

## Automatic Dolby Vision SDR Version

Every successful `masterType=dolby_vision` upload now also attempts to create an independent SDR master. The original Dolby Vision stream is copied and verified first; the SDR conversion never modifies it.

- Profile 8.4 uses its HLG base layer; PQ-compatible sources such as Profile 8.1 use their PQ base layer. FFmpeg `zscale` linearizes the HDR signal, `tonemap` maps highlights, and the output is converted to BT.709 limited-range 8-bit H.264 with AAC audio. This CPU path does not apply Dolby Vision RPU metadata.
- Sources without a compatible HLG/PQ base layer, including Profile 5, require embedded RPU metadata and an FFmpeg build with `libplacebo` and a working Vulkan device. That path applies the embedded Dolby Vision metadata.
- The SDR MP4 and fMP4 HLS are stored in their own versioned directory under `media/<slug>/sdr/`. The generated record has `is_derivative=true`, `derived_from_master_id`, and the conversion filter and intent. Its file URL points to the SDR MP4, while its source probe/hash identify the original master.
- Both the converted MP4 and packaged HLS must pass SDR color checks before registration. The original color-preservation gate remains strict; intentional conversion is recorded separately in `color-verification.json`.
- `isDefault=true` makes the generated SDR the default once it is ready. Otherwise an existing default is preserved; if no default exists, the SDR becomes the default. Manually uploaded SDR records are never overwritten by automatic derivatives. With `overwrite=true`, replacing a Dolby Vision master updates its paired automatic SDR record, even if the label changes.
- The upload waits for SDR processing. The form distinguishes file upload from server processing and reports success or partial failure. `VIDEO_SDR_PROCESS_TIMEOUT_MS` bounds encoding (default one hour); proxy timeouts must allow the full upload and processing duration.

The player exposes both verified masters. Manual switches preserve playback position and whether playback was active. If Dolby Vision fails to load or decode, the player automatically selects its paired verified SDR, or another verified SDR if needed. SDR failure stops with a retry action; it cannot loop back to HDR.

If SDR encoding or verification fails, the original Dolby Vision remains saved and playable. The upload response includes `sdrDerivative.status=failed` and an error, and no unverified SDR record is published. Fix the reported issue and upload again with `overwrite=true` to retry. Existing uploads are not retroactively converted.

When an overwrite changes the source hash, the previous automatic SDR is quarantined until regenerated, so playback cannot silently fall back to an older edit.
