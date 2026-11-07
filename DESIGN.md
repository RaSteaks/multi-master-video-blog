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
  lineLight: "#2C3840"
  supportBody: "#C4CED8"
  supportTrackAhead: "#5D6B7B"
  supportLabelAhead: "#8A98A6"
  supportZoneA: "#13171C"
  supportFocus: "#86B8DC"
  supportLinePlayback: "#D9A35E"
  supportLineColor: "#74C290"
typography:
  sans:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  mono:
    fontFamily: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Consolas, monospace'
rounded:
  swatch: 8px
  preview: 4px
  supportPlate: 10px
  supportControl: 6px
  supportSign: 0.6em
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
Controls retain their dark surfaces and readable labels. Hairlines use
`--line-light`. The standalone `/support` snapshot adds support-only roles:
a softer body-copy reading tone, dimmed track and label tones for the route ahead,
one raised zone fill, and a single focus blue reserved for "you are here". Colour is
otherwise allowed in only two roles: line identity (amber playback line, green
colour line, as on a transit map, always paired with line form) and colour that is
itself the data in the station figures, shown as labelled sRGB approximations.

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
corners and inset preview chips use 4px corners. On `/support` the map plate, the 6px
readout controls and the em-relative station signs use the `support*` radii.

## Components

- `/support` is a standalone, Chinese-language static technical guide in
  `apps/web/public/support/`, served by a frontend rewrite without the CMS-backed
  layout. Its CSS snapshots the reference-room surface/text/font tokens above;
  it deliberately has no live appearance settings or remote dependencies.
  It is a route map: one inline SVG network over three ownership zone bands
  (服务器 and 网页播放器 are this site's code; 浏览器与系统 is decided by the
  platform), alternating the `supportZoneA` fill with the page background. The
  playback line (P1–P6) is a solid stroke, the colour line (C1–C6) a hollow double
  rail, the SDR branch dashed and the fallback dotted; the lines interchange in
  pills at probe, packaging, decode and display. One ride order, P1 P2 C1 P3 C2 C6
  P4 P5 C3 C4 C5 P6, makes C6 a spur trip that returns to the main line. Line
  identity pairs form with hue: the playback line in `supportLinePlayback`, the
  colour line and its SDR branch in `supportLineColor`. State is brightness: passed
  spans light in their line's hue and stations turn bright, those ahead stay in
  `supportTrackAhead` / `supportLabelAhead`, and `supportFocus` is reserved for the
  current stop, its ring, the trail and the marker. Station signs (2px rounded
  rules in the line's hue, double for colour, dashed for SDR; the current stop's
  sign turns `supportFocus`) are the page-wide numbering system in
  stop headings, the readout, the ticks and the metadata, format and
  troubleshooting cross-references, which all ride to their stop. Scroll drives the
  marker: it holds for the first half of each stop, then eases along the real leg;
  an interchange pill takes the accent during its transfer, and a terminus runway
  lets the train reach 屏幕 while the map is still pinned. The in-car readout under
  the map shows current and next stop, 12 ticks drawn in each stop's line form, and
  上一站/下一站 buttons. Desktop pins the map plate with the readout beneath; windows
  761–860px tall fold the readout label, 561–760px tall tighten insets to a two-line
  readout, and a map drawn below 80% scale enlarges its labels up to 1.25× from JS.
  At ≤860px wide or ≤560px tall the whole map sits once in flow with codes only,
  then the readout pins under the header as a route strip; wide-but-very-short
  windows centre a 720px column. Reduced motion moves the marker only between
  stops; without JavaScript the full static map and every stop remain readable.
  Legacy `#playback`/`#color` anchors open P1/C1, and cached stop geometry keeps the
  scroll callback free of layout reads. Each stop also carries one station figure
  (`figures.js`, canvas on the `supportZoneA` plate, 16:9 / 16:11 / 2:1 desktop,
  4:3 or 1:1 on phones; P1/P5 5:2, P6 2:1) in the reading column, scrubbed by its
  own scroll position: it starts only once the whole plate is inside the readable
  window (below the header, or below the pinned strip on phones) and finishes as its
  top is about to leave, over at least 200px of scroll, so every frame plays fully
  in view. Figures are drawn in the map's grammar: `--text` for what is current
  or resulting, `--secondary` for references, `supportTrackAhead` for ghosts and
  what is not yet reached, dashed only for the SDR branch, dotted only for fallback,
  and `supportFocus` only for the playhead, in-flight work and the current step.
  Hue appears in figures only where colour is the data: the C1 horseshoe fill (36%
  over the plate), the C5 sample dots and the C6 edges coloured by RGB position, all
  computed as sRGB approximations (out-of-gamut chromaticities desaturated toward
  white at full brightness) and labelled as such in their captions. Coloured marks
  (dots, edges) also get a luminance floor mixed toward white so even sRGB blue
  keeps 3:1 on the plate; grey reference lines over the C1 fill carry a dark casing.
  Canvas colours read the CSS tokens with identical fallbacks, because WebKit may
  run the deferred script before custom properties resolve. Where a formula exists
  it is computed: CIE 1931 xy locus and primaries (C1, C5), ST 2084 and BT.2100
  HLG with the display-peak system gamma (C4, peak slider), limited/full code-value
  mapping (C3), and the C6 volume: a BT.2020 RGB cube at 1000 cd/m² in ICtCp,
  BT.2390 EETF to 100 cd/m² with chroma scaled by I, then a simplified constant-I
  desaturation into BT.709 (labelled as not libplacebo's mapping), framed so the
  whole 1000 cd/m² source stays on the plate with a luminance ruler outside the
  solid; drag or arrow keys rotate it and the canvas is a labelled slider. P4 follows
  `selectAutomaticMaster`: HDR report, candidate ranking, then first variant and
  decodingInfo() per candidate until one passes. Upload chunks, probe,
  packaging cut points, verification layers, decode paths and fallback timelines are
  illustrations whose captions say so. P4 can run this device's matchMedia and
  decodingInfo() with example configurations, only on request and without network
  requests. A figure's status line has a fixed height so scrubbing never shifts the
  page; reduced motion shows each figure's final frame; without JavaScript the
  figures stay hidden and the text carries every fact. Native disclosures hold format details and
  troubleshooting. Home places Support immediately below Info; both About render paths
  link to it. `data-native-navigation` keeps these document links outside route wipes.

- The `/project` laboratory reuses the reference-room palette and type. Its two-column
  desktop / single-column mobile default remains available alongside six author-owned
  templates: catalogue/exhibit, mosaic, alternating, masonry, groups and dual feature.
  `site_settings.project_layout` is the shared persisted choice; only verified author
  management shows the native radio options and explicit save/cancel-preview actions.
  Unsaved choices affect the author's preview only; visitors have no layout selector,
  local preference or URL override. `ProjectLayoutSettings` owns selection/save feedback,
  `ProjectCollection` owns rendering, and `SortableGrid` continues to own ordering.
  In the catalogue at widths up to 700px, selecting a directory item immediately
  scrolls to the exhibit and focuses its view/open card; desktop focus stays in the directory.
  Group names are author-entered, with first-occurrence ordering and an ungrouped fallback.
  Pictures are unfiltered; variable picture ratios reveal more/less of the same 1280px
  website viewport without stretching it. Cards contain a title and description.
  `AuthorMenu` owns global creation; its device hint controls visibility and
  verified author sessions own management. `SiteDialog` reuses native modal geometry and focus
  behavior for the editor/viewer. The full-window viewer reserves a neutral toolbar
  outside the target pixels. `Projects.module.css` and `ProjectLayouts.module.css` consume existing runtime tokens,
  not a separate palette. See `docs/external-projects.md` for lifecycle and permissions.
  Automatic website pictures share a budget of three on desktop and one at widths
  up to 700px; unscheduled cards keep their cover/placeholder. Frame `load` is an
  unverified compatibility signal, never proof of a rendered picture. Targets need
  no custom script. The viewer keeps retry and independent opening reachable after
  that signal, and unanswered thumbnail loads return to their fallback after 12s.

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

- `HomeDiagram` draws reference line work on a canvas above the liquid background
  and behind the home cards, in the empty side of the desktop composition and at
  low opacity behind the cards at 1200px and below. It offers a vectorscope (standard,
  points, ×2) and a waveform (luma, RGB or YCbCr parade, RGB overlay), both read from
  one scan line of a real Rec.709 signal (`scope-signal.ts`: 75% or 100% bars, a hue
  sweep or ColorChecker) with white, green, amber or signal-coloured phosphor, and
  random grain per visit (`scope-drawing.ts`), or a slowly turning gamut solid
  (`color-volume.ts`: Rec.709, P3-D65, Rec.2020 or ACES AP0, a random one each visit
  unless pinned, in CIE XYZ, CIE xyY, CIELAB, Oklab, ICtCp or CAM16-UCS, with labelled axes).
  XYZ and xyY are as measured, so AP0 keeps its D60 white and its negative Y. xyY
  places chromaticity x/y on the base and relative luminance Y upward (white Y=1);
  edges approaching black use their own limiting chromaticity, never an invented
  common black xy. The six coordinate choices use two rows of three. The appearance
  models adapt AP0 to D65. Everything drawn is computed from the real signal or model, and only
  the solid animates; reduced motion leaves one still frame. Above 1200px, where it
  clears every card, the solid can be dragged: a flick is speed-limited and eases back
  to the resting turn, and reduced motion keeps dragging without the throw. By default each visit
  draws one of the three diagrams at random, with every option of that diagram random
  too; choosing a diagram pins it, and its signal, style and phosphor can each stay
  random or be pinned. The Appearance
  background tab chooses it per browser (`home-diagram.ts`), including off. Storage
  events synchronize resets across tabs; an in-memory override exists only while
  persistence fails, and also represents a local reset explicitly.

- `SortableGrid` gives a signed-in author GitHub-style ordering on the videos,
  articles, albums and laboratory lists: a six-dot handle chip at each card's top
  right, always visible to the author and absent for visitors. The dragged card
  follows the pointer over a dashed slot while the others glide aside (additive
  WAAPI, so interrupted glides turn smoothly); near the window edges the page
  scrolls, Escape cancels, and arrow keys, Home and End move a focused handle.
  Mid-drag the order is CSS `order` only, because moving DOM nodes drops pointer
  capture and reloads laboratory frames; dropping commits the DOM order, saves at
  once and announces through a live region. A failed save restores the last saved
  order with a visible message. `/api/content-order/<section>` rearranges only the
  submitted works within the slots they hold, so drafts and works past the visible
  page never move; arranged rows count from 1, so a new work (0) leads its list.

- `ContactStrip` closes the home page, on the first screen wherever the content
  fits: published videos,
  articles, albums and laboratory sites on full-width film, with the album card's
  sprocket values turned to run along it, fading out toward both window edges as the
  owner's explicit exception for this strip. Time runs left to right by date added.
  The newest frame holds the centre of the page with bare film ahead of it, and older
  frames scroll away to the left, with room to clear the fade. Records stay capped
  at the 200 most recently added per collection, independent of list-page order. A project link carries
  its ID as a query parameter so the laboratory can fetch one public target beyond
  the first page, without changing ordinary pagination or exposing drafts, and an
  in-site project opens directly in its viewer over the list. Pictures
  are not tinted or covered. Hovering or focusing a frame is a light table: one lamp
  under the film follows it, lighting the base and sprocket holes around it, the
  frame rises 14% from its lower edge, and a centred label hangs below
  the frame, with the MM-DD added date above the title,
  and a work with no cover shows its title in the frame. A coverless laboratory site
  runs the shared `ProjectPreview` instead: on-screen frames only, the newest three
  at most (one up to 700px), never under reduced motion, with its title beneath until
  the frame fires its unverified load event.
  If the CMS fails the strip is omitted and the page still renders.
  A frame prefetches its full destination only when a pointer rests on it for 90 ms,
  is pressed or takes focus, so a low-memory host never fetches the whole strip. On
  a click it opens: the destination is revealed from the frame's own rectangle out
  to the window behind a lit 1 px edge, while the old page dims. A picture with the
  same cover waiting (article, video) flies there on the same curve, so it stays
  inside the opening; albums and laboratory sites dissolve in place. It may wait up
  to 3s for real pixels, then switches directly as any late navigation does.

- The loading line ramps from pure black at the left to pure white at its leading
  end, and on finishing reaches the right edge before it fades. SDR is a CSS gradient. `@media (dynamic-range: high)` layers a cICP-tagged
  BT.2100 HLG PNG (`scripts/generate-hlg-ramp.cjs`), whose peak signal follows the
  display's own headroom. There is no setting; a capable browser and display get
  it automatically.

- Backdrop declarations use `-webkit-backdrop-filter` before `backdrop-filter`
  so production CSS retains the standard property. Blur values are unchanged.

- Motion roles are owned by the `--motion-*` variables in `globals.css`: controls
  130 ms, panel changes 260 ms / 12 px, media reveals 180 ms, emphasis 420 ms,
  route wipes 1200 ms, strip frame openings 760 ms, and reduced-motion fades 100 ms. These are role budgets rather than mandatory
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
  First-screen images and coverless laboratory previews get up to 300ms before
  the wipe starts. A preview that needs longer fades in behind the line.
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
  From 1200px a two-column console keeps stack health, the 2 × 2 service cards
  and live output in the main column. A 380px rail holds the current task, then
  the source repository and the Manager itself. The current-task card is the
  only sticky element. It merges the live phase, the latest command feedback
  and the latest operation's steps, which fold once that operation succeeds.
  Rail items span every row, so a tall task card never pushes the services
  down. Narrower layouts use one column in the same priority order, which is
  also the DOM and focus order; from 900px the repository and Manager panels
  pair up. Settings (credentials, configuration backup, database facts) form a
  separate band after the console. The rail shows the three newest incoming
  commits; checkout details and commands stay in disclosures.
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
