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

- The `/project` laboratory reuses the reference-room palette and type. Its two-column
  desktop / single-column mobile cards contain only a 16:10 unfiltered website picture,
  title and description. `AuthorMenu` owns global creation; its device hint controls visibility and
  verified author sessions own management. `SiteDialog` reuses native modal geometry and focus
  behavior for the editor/viewer. The full-window viewer reserves a neutral toolbar
  outside the target pixels. `Projects.module.css` consumes existing runtime tokens,
  not a separate palette. See `docs/external-projects.md` for lifecycle and permissions.

- `ActionMenu` owns the shared disclosure panel, keyboard focus and the same
  circular reveal/conceal as `AppearanceControl`; its radius follows live panel
  dimensions. `PageTools` owns public, route-specific tools and the `N` shortcut.
  Its 26px SVG has four 8.5px swatches (1.8px gaps, 1.1px radii), with tones
  #E2E8EE / #A9B3BD / #737D88 on #1e2328; opening rotates only their fills
  clockwise, using `--motion-panel-duration`. The old framing corners are removed.
  `AuthorMenu` is a separate client-only, 40px neutral icon in the header, or
  left of Appearance on home. No visible label/title/badge; a 6px task dot is
  the only busy indication. Completion keeps a success-colored dot for six
  seconds; failure keeps a danger-colored dot until the panel is viewed, where
  bounded failure details remain available. Dots never animate or gain labels.
  The panel retains task detail and author actions.
  `author_device` controls visibility only; `AuthorSignIn` and server sessions
  own authorization and action continuation. `/studio` and Cmd/Ctrl+Alt+Shift+L
  expose sign-in on new devices. See `docs/deployment.md` for cookie semantics.
  `dropped-files.ts` retains the in-memory handoff; the full-window drop layer
  only selects files and never submits. Local upload zones keep their own drops.
  `AuthorCredential` owns manual overrides; explicit article credentials retain
  separate authority. `author-tasks.ts` polls only signed-in visible readers.
  The floating public control stays outside the route wipe and yields to playing
  media, viewers and fullscreen. Reduced motion removes swatch transitions.

  `AuthorSignIn` reuses the native album-dialog geometry with global tokens,
  never album-scoped amber. Sessions expire after six hours and synchronize
  status across tabs; `docs/upload-api.md` owns the authentication contract.
  Shortcuts leave text inputs, IME and open dialogs alone. Reduced motion removes
  displacement and scale transitions. Media pixels are never decorated, tinted,
  dimmed or blurred. The API remains the file-validation owner. Task byte/film
  progress is measured, encoding is indeterminate, and completion is temporary.

- `AuthorTray` is the held-Tab variant of the existing author actions, with the
  same route groups, icons and Link navigation guards as `AuthorMenu`. It is
  available only for a verified session and a fine pointer. A short Tab advances
  page focus on release (wrapping at the end); holding 180ms opens a circular tray
  centered exactly on the pointer. The 340–352px disk reads as a lens iris:
  curved HTML Link blades leave a near-circular opening along its tangent, the
  first action at twelve o'clock and each label on its blade's center. The
  opening (36%) is the cancellation zone. An author device with a lapsed session
  explains a held Tab with a short hint instead of opening; short Tab is unchanged.
  Moving onto a sector highlights it; releasing Tab follows its real Link. Release without a target, Escape, blur, resize, route/session change
  and modal/fullscreen entry cancel. Inputs, editor content, native media focus,
  Shift+Tab and existing panels keep their own keys. The ordinary menu remains
  the keyboard/click alternative. The body portal uses `--z-author-tray` (90),
  `--surface-strong`, `--line-light` and existing accent/type/radius tokens.
  It opens with the appearance panel's circular reveal centered on the pointer
  (220ms) while the blades turn back and the opening dilates, then labels arrive
  clockwise. Only the decorative layer moves, so hit areas are live throughout.
  Cancel stops the iris down onto the pointer; commit lifts the chosen blade and
  clears the disk, then navigates after 150ms so the route wipe never snapshots it.
  Blur, resize, modal and fullscreen entry remove it instantly.
  `tabbable` owns short-press focus ordering so disabled, hidden and radio controls
  do not require a custom selector. Native input/menu Tab and Shift+Tab are untouched.
  The center never shifts away from the cursor. With insufficient edge clearance,
  a temporary hint requests an inward move; the disk opens only once its full
  radius fits with 12px margins. A window too small retains the ordinary menu
  alternative. It never dims or blurs page/media, and only fades for
  `--motion-control-duration`; reduced motion removes that fade.

- `LiquidBackground` multiplies saved speed by 0.35 on article/video details
  without modifying colors or preferences. It updates the live WebGL controller
  and local CSS duration variables together. `player-viewing.ts` owns the
  2.5-second watching timer, whole-player fullscreen and mobile immersion;
  `html[data-watching]` drives surrounding chrome opacity and pauses liquid
  rendering only in fullscreen. Pointer focus does not prevent fading; keyboard
  control focus does. Auto immersion is phone-only (coarse pointer, landscape,
  viewport height at most 500px). Manual exit is respected until portrait return.
  Player geometry is reserved during fading; unmount never restores old scroll.
  Standard native fullscreen is promoted when allowed, with stacked elements
  unwound together on exit; native video-only fallback remains a documented limitation.
  Home's three action slots use published project links and laboratory fallbacks;
  profile, layout breakpoints and visual tokens remain unchanged.

- Backdrop declarations use `-webkit-backdrop-filter` before `backdrop-filter`
  so production CSS retains the standard property. Blur values are unchanged.

- Motion roles are owned by the `--motion-*` variables in `globals.css`: controls
  130 ms, panel changes 260 ms / 12 px, media reveals 180 ms, emphasis 420 ms,
  route wipes 1200 ms, and reduced-motion fades 100 ms. These are role budgets rather than mandatory
  effects on every element. Keep the reference-room identity; media comparison
  surfaces must not receive decorative colour, luminance or blur changes.
  `NavBar` fully prefetches its five routes. `PageTransition` permits header
  navigation up to 3s to prepare real old/new snapshots (other links retain the
  180ms budget, or 450ms toward home). The divider and revealed pixels share one
  native transition. A timed-out/rejected snapshot switches directly: never tint
  an already-visible destination and replay a decorative divider over it. No
  live page subtree is clipped/transformed; navigation/history cancels prior
  effects, and reduced motion remains unanimated.
  The root snapshot reveal keeps the header region visible from the first frame;
  its navigation pill settles on the target before capture to avoid a frozen
  intermediate position. Ordinary navigation retains the pill slide.
  List sections hold still under the wipe: `ListHeader` gives videos, posts,
  albums and the laboratory one title position and content start, and
  `.content-grid` gives them six columns and one gutter (standard cards span two,
  wide cards three). `MediaCard` fills every card, so a contact sheet differs from
  a laboratory card only by the sprocket rails beside its picture. The liquid
  background is one root-level instance, so navigation never restarts it.
  First-screen images get up to 300ms to decode before the wipe starts, and
  laboratory previews wait for it to finish.
  The divider is painted directly on its native image-pair layer (not a new-only
  element image), and both wipe animations share one start time. Pixel checks
  verify old/new visibility, the header, and the divider's alignment to the reveal.
  `panel-motion.ts` reads the runtime tokens for live content transitions and
  interruption cleanup. Appearance category controls remain usable immediately;
  local transitions do not take document snapshots or compete with route motion.
  The existing viewport-bounded panel and its anchor remain unchanged. Reduced
  motion skips displacement and resizing and permits only a short fade.
- `ArticleToc` owns the current-section marker and mobile collapse/anchor focus.
  It changes colour without moving a marker and preserves router history state.
  `ArticleReading.module.css` owns an optional article-only progress line; it is
  omitted without scroll-timeline support and under reduced motion. The footer
  and cover are not reading progress. `MarkdownAssetImage` adds a neutral, sized
  loading surface and a decode-aware reveal while keeping cached, failed and
  server-only images visible. Image metadata remains owned by the existing CMS
  asset-dimensions path; no extra placeholder requests or colour extraction occur.

- `scripts/manager-dashboard.cjs` owns the standalone Service Manager. Preserve
  its existing system-font, light/dark operational console and CSS variables;
  it is separate from the public site's reference-room theme. Service cards,
  native confirmation dialog and persistent operation panel share action names
  with `scripts/service-control.cjs`. Keep read-only refresh/log controls usable
  during operations, retain keyboard focus across polling, and show actual named
  phases and terminal failures rather than estimated percentages. The command
  and recovery contract is documented in `docs/deployment.md`.
  Application updates show dependency installation as a named journal phase and
  reuse the existing log viewer for Dependencies. Confirmation explains the
  stop/install/build/start order and failure recovery; percentages are not guessed.
  `managerStyles()` supplies the same tokens and controls to the dashboard and
  `scripts/manager-login.cjs`. The login is a compact Chinese-language form with
  inline validation, password visibility, and stable pending/error space. Browser
  authentication uses a session cookie and an explicit logout control. All HTTP
  clients use the same throttled login; operation nonces are bound to the session.
  Session rules live in `docs/deployment.md`.

- `FilmScanImport` owns film job feedback. Progress polling is serialized, bounded,
  canceled on navigation, and reduced while hidden; full frames load on review readiness. Resource-blocked jobs retain originals
  and use the existing inline status region and refresh action; they must not
  reuse the failed-job copy that says originals were removed. Runtime state and
  restart behavior are defined in `docs/linux-deployment.md`.

- `AlbumGallery` owns both public and managed photo tiles. Album pickers load bounded
  summaries; management loads the selected album before switching dialogs, retains
  the current form on failure, and ignores canceled responses. Its responsive CSS grid
  follows row order so number badges, keyboard focus, lightbox navigation, and the
  first three eager images agree. Images retain their natural aspect ratios;
  Directus display dimensions reserve their space in both modes. Named thumbnail
  parameters come from `config/directus-asset-presets.json`, shared with CMS setup
  and validation; no fixed skipped-content height is used for these tiles.
  Its native-dialog lightbox keeps wrap-around paging and delegates browser
  pinch zoom; single-pointer image gestures never intercept toolbar or rail
  controls. `AlbumLightbox.module.css` owns the fading scrim while global
  descendant image sizing remains shared. A ready SDR image may morph to/from
  its visible tile; HDR, off-screen sources and reduced motion use the simple
  fallback. Only different SDR photos may cross-fade; rendition comparisons
  cut after the replacement has decoded. Public neighbour preloads are bounded;
  authenticated management images never use speculative anonymous requests.
  Closing and reduced-motion changes must also settle interrupted drag effects.

- `MediaPlayer` owns delayed loading/switch feedback; globals.css owns only the
  playback frame line. A single decoder retains time and play intent across
  superseded requests. A verified SDR canvas hold is optional and must never
  turn an HDR source into an SDR still. A confirmed replacement frame releases
  the hold with a cut, without blending renditions. All pending waits are bounded
  and cancellable, including a browser play request that never settles. Master-number
  shortcuts are scoped to the player. Fullscreen F is page-wide but leaves
  editable targets, IME, open dialogs and the author menu alone.
  Chinese action/status feedback follows the site locale; technical format names
  remain the source labels. Screenshot tests do not certify HDR brightness or
  physical touch behavior, which require device checks.

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
