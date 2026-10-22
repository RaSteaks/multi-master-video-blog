---
version: alpha
colors:
  primary: "#7A7A7A"
  background: "#0C0E10"
  surface: "#161A1E"
  overlay: "#252C34"
  text: "#E2E8EE"
  secondary: "#9AAABB"
  liquidBase: "#000000"
  liquidDefault: "#82868A"
typography:
  sans:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  mono:
    fontFamily: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Consolas, monospace'
rounded:
  swatch: 8px
  preview: 4px
---

# Reference Room design context

## Overview

This Chinese-language media blog uses a restrained dark reference-room visual
identity. Appearance settings are a compact utility panel, with immediate preview
and browser-local preferences. Preserve the existing typography and layout.

## Colors

The runtime CSS variables in `apps/web/src/app/globals.css` are canonical.
Surfaces use `--background` (#0C0E10), `--surface` (#161A1E), and
`--surface-overlay` (#252C34). Primary text uses `--text` (#E2E8EE), with
`--text-secondary` (#9AAABB). Global accent overrides remain separate from liquid
background preferences. The liquid surround always stays pure black (#000000);
HSV and saved colors affect only the flowing blobs, without white mixing.
Black dye blends into the black surround; the default dye is neutral gray.
WebGL composites dye onto opaque black before browser blur/compositing.
Controls retain their dark surfaces and readable labels.

## Typography

Use the existing `--font-sans` and `--font-mono` families. Chinese labels describe
actions; HEX and numeric readouts use the monospace family. Do not introduce fonts
for individual settings.

## Layout

The appearance panel keeps its existing width, viewport-bounded vertical scroll,
and mobile placement. Background precedes Color and is initially selected.
Liquid settings use a three-column grid: one protected default plus five custom
slots. Disclosure expands HSV controls inside the existing scroll area.

## Elevation & Depth

Reuse the existing near-opaque dark panel, fine borders and focus outlines.
Default liquid rendering preserves the original video gray layers and grain.
Six softly separated dye sources cover the surround; smaller source radii and
balanced injection preserve black gaps. The CSS fallback also uses six blobs,
while reduced motion retains one static blob.

## Shapes

Reuse the existing rounded input and panel geometry; swatch controls use 8px
corners and inset preview chips use 4px corners.

## Components

- `scripts/manager-dashboard.cjs` owns the standalone Service Manager. Preserve
  its existing system-font, light/dark operational console and CSS variables;
  it is separate from the public site's reference-room theme. Service cards,
  native confirmation dialog and persistent operation panel share action names
  with `scripts/service-control.cjs`. Keep read-only refresh/log controls usable
  during operations, retain keyboard focus across polling, and show actual named
  phases and terminal failures rather than estimated percentages. The command
  and recovery contract is documented in `docs/deployment.md`.

- `FilmScanImport` owns film job feedback. Resource-blocked jobs retain originals
  and use the existing inline status region and refresh action; they must not
  reuse the failed-job copy that says originals were removed. Runtime state and
  restart behavior are defined in `docs/linux-deployment.md`.

- `AlbumGallery` owns both public and managed photo tiles. Its responsive CSS grid
  follows row order so number badges, keyboard focus, lightbox navigation, and the
  first three eager images agree. Images retain their natural aspect ratios;
  Directus display dimensions reserve their space in both modes. Named thumbnail
  parameters come from `config/directus-asset-presets.json`, shared with CMS setup
  and validation; no fixed skipped-content height is used for these tiles.

- `UploadVideoForm` owns new-project, paired HDR/SDR, and existing-project uploads.
  `VideoProjectPicker` owns authenticated project search and explicit selection.
  These flows reuse the existing upload panels, native inputs/selects, typography
  and CSS tokens; no separate visual theme or persistence of credentials is introduced.
  Behavioral contracts live in `docs/upload-api.md` and `docs/video-workflow.md`.
  `video-upload.ts` owns chunk transfer, confirmed progress and safe resume.
  The task panel reuses the upload panel tokens and keeps authentication editable
  for recovery; it separates byte progress from queued/processing states.
  Only the recovery ID is stored locally. A refreshed page reselects and verifies
  original files, while completed uploads keep the existing result/add-master flow.
  `VideoFormatInfo` presents bounded source identification only in upload results.
  `MediaPlayer` omits source/current-version summaries and source provenance from
  Playback Info, which retains stream technical details and device capabilities.
  Unknown provenance never changes playback capability detection or claims validation.

- `AppearanceControl` owns the non-modal appearance panel and tab keyboard behavior.
- `HsvPicker` owns the shared saturation/value plane, hue slider and numeric fields.
- `LiquidSettings` owns disclosure and slot feedback, including a one-step undo.
- `liquid-preferences.ts` owns versioned validation, color derivation and startup.
  Its `--liquid-base`, `--liquid-blob-1/2/3`, `--liquid-duration-1/2/3`, and
  `--liquid-play-state` variables feed the low-resolution client-side fluid
  renderer and its CSS fallback. WebGL is limited to a small simulation grid
  and never runs on the server.
  CSS fallbacks exactly match the runtime default gray palette. Theme accent
  variables are never inputs to liquid colors.

## Do's and Don'ts

Keep default gray immutable and preserve collections when resetting backgrounds.
Use native controls, visible focus and explicit save/overwrite/clear labels.
Respect reduced motion even when saved speed is positive. Storage failure must
not block editing, and must be reported inline. Do not silently save HSV edits
over a collected color or write remote preferences.
