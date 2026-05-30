# Video Workflow

## Manual HLS Workflow

1. Export video masters from DaVinci Resolve or another editing tool.
2. Create SDR, HDR10, HLG, Dolby Vision, or custom versions as needed.
3. Package each version as HLS.
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

HDR10, HLG, and Dolby Vision masters should include:

- `codec`
- `color_space`
- `transfer_function`
- `bit_depth`
- `resolution_width`
- `resolution_height`

The frontend player should default to SDR and let users manually switch to HDR-capable versions.

The current frontend player uses Shaka Player and supports HLS playlists generated as either MPEG-TS segments for SDR or fMP4 segments for Dolby Vision copy-mode uploads.

## Automated Upload Workflow

For automated processing, use the upload API:

```text
POST /api/uploads/videos
```

The backend stores the source file under `media/<slug>/source/`, generates HLS under `media/<slug>/<master-type>/`, and writes `video_projects` plus `video_masters` records to Directus.

Dolby Vision uploads should use `mode=copy` to avoid stripping or re-encoding the Dolby Vision metadata.
