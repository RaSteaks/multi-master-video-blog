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

Dolby Vision, HDR10, and HLG uploads must use `mode=copy` to avoid stripping or re-encoding color metadata. Prepackaged HLS uploads use `sourceKind=hls_package` and must include a multivariant playlist with `VIDEO-RANGE`.
