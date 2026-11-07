# Website laboratory (`/project`)

The laboratory lists independent websites without importing their application
code into the blog. Public cards contain a cover/live picture, a title and an
optional short description. URLs remain in the management form, not card copy.

## Setup and storage

Use the repository's Node 22 runtime. Run the additive CMS setup against the
intended local installation, then restart the API and rebuild/restart the web
service as appropriate:

```sh
node scripts/setup-directus-schema.cjs --external-projects-only
```

The normal `npm run setup:cms-schema` also includes this collection. The narrow
flag installs the website collection, fields, cover relation and its layout setting.
It also repairs the legacy theme-color validation rule that prevents layout saves;
custom validation and unrelated CMS settings are preserved. `external_projects` is included in the private
CMS collection policy. No anonymous Directus collection permissions are needed.

If production shows “实验室暂时无法载入” while local development shows an empty
list, inspect `GET /api/external-projects`. A Directus 403 saying
`external_projects` does not exist or is inaccessible means the production
collection or service permissions are missing, not that there are zero projects.
Run the narrow setup above on the intended deployment if the collection is
missing. If it already exists, verify the API and Web service accounts can read
the listed fields; the authoring API account also needs create/update access.
Keep anonymous Directus access disabled. Linux Manager's Pull applies required
schema upgrades automatically when CMS, API and Web all run from its checkout.
Windows Update API + Web and separate release/Docker deployments retain explicit migration steps.

Fields: `title`, `description`, `group_name`, `url`, `preview_url`, `preview_enabled`,
`open_mode` (`iframe` or `external`), `cover_image`, `published`, `sort_order`,
`created_at`, and `updated_at`. Lower sort values appear first. Drafts are the
default. Website addresses must be HTTPS without embedded credentials; local
HTTP loopback URLs are accepted only in development for isolated verification.
The API stores URLs and never fetches them or proxies arbitrary website HTML.

Linux checkout deployments use Manager's Pull (or Apply schema when code is
already current). Other existing installations add the layout fields with:

```sh
node scripts/setup-directus-schema.cjs --project-layouts-only
```

This adds `external_projects.group_name` and `site_settings.project_layout` without
changing the active layout or publishing projects. It also repairs the legacy
bare theme-color regex into Directus's field-keyed validation format; that old
format causes recursive validation failures on all site-settings writes.
Custom validation rules are preserved. The normal setup and
`--external-projects-only` also include these fields and the same validation repair.
If the color field has not been installed, there is no legacy rule to repair.
API service permissions must
allow reading/writing the singleton layout field; the Web service only needs read
access. Anonymous Directus access stays disabled. Run the migration on the intended
installation before using the new author controls; deployment is a separate step.

## Author-owned layout templates

**管理网站 → 展示布局** offers the original **双列展示** plus six templates:

- **目录与展台** (`catalogue`): select a project from the directory, then use its
  large card to view/open it. At widths up to 700px, selection scrolls directly to
  the exhibit and focuses its view/open card; desktop selection keeps focus in
  the directory. Only the selected project can run a preview.
- **拼贴展墙** (`mosaic`): repeating wide/narrow card compositions.
- **图文交替** (`alternating`): pictures and descriptions alternate sides.
- **错落瀑布** (`masonry`): varying picture ratios with measured grid row spans;
  DOM order, keyboard sorting and pointer sorting use the shared sortable grid.
- **分组陈列** (`groups`): use **编辑网站 → 展示分组** (at most 60 characters).
  Groups follow their first appearance in author order; blank names join
  **其他作品**. Sorting within a group rearranges only that group's loaded rows.
  Change a project's group in the editor to move it to another section.
- **双主推** (`dual`): the first two projects get large cards; remaining cards
  use compact horizontal entries. Existing author ordering determines the leads.

Selecting a template previews it locally. **保存布局** persists it for all visitors;
**取消预览** or returning to public display restores the saved choice. Save failure
keeps the selection and leaves the public layout unchanged. A save does not discard
already-loaded pages. Visitors have no layout controls and cannot override the
choice with local storage or URL parameters. Responsive reflow is part of each
template. Empty lists and single projects remain supported.

- `GET /api/external-projects/layout`: public `{ layout }`, with `Cache-Control: no-store`.
- `PATCH /api/external-projects/layout`: `{ layout }`, protected by the existing
  author session + CSRF (or explicit upload token), with a strict field allowlist.

The API and server-rendered page read the CMS choice without caching; new visits
and refreshes observe the saved value without requiring a Directus webhook. An
unset choice retains the original `grid`. If settings cannot be read, the public
page keeps the original layout and the author panel explains the unavailable
setting. An unmigrated grouping field is omitted from read queries so public cards
remain available; writes require the schema update. Public page requests never
perform migrations; only the authorized Manager update workflow does so automatically.

## Author workflow and endpoints

The header author menu (`AuthorMenu`) owns **添加网站** and opens
`/project?dialog=create`. The non-authorizing `author_device` hint reveals its
entry; expired sessions sign in and then continue the selected action. No second login system or per-project token is introduced.
The page's author-only **管理网站** control shows published records and drafts.
Its per-card menu edits or changes publication. Sorting is edited in the form.

- `GET /api/external-projects?page=1`: published rows, 24 per page with `hasMore`.
- `/project?project=<id>`: the contact strip's public destination.
  An in-site project opens straight in its viewer; closing it scrolls to its card
  on the list and drops the query, so a reload shows the laboratory.
  The server adds the requested published project when it is outside the first
  page; ordinary Load more keeps its page offsets and deduplicates that row.
  Missing or unpublished targets show an unavailable notice alongside the public
  list, and an independently opened project stays a card. The query never enables
  draft or management access.
- `GET /api/external-projects/manage?page=1`: same bounded listing including drafts,
  protected by the existing upload authority (session + CSRF or explicit token).
- `POST /api/external-projects`: create; JSON or multipart.
- `PATCH /api/external-projects/:id`: update; JSON or multipart.

Writes use the existing author-session headers. Multipart accepts metadata and
one `cover` image; `removeCover=true` removes the association, not the stored
original. Uploads reuse the existing 12 MiB image limit and MIME/signature checks.
Clients cannot assign arbitrary CMS file IDs. Published cover access is checked
on every asset request; unpublishing revokes public access. Authenticated draft
covers use the existing blob-preview component. An uncertain CMS mutation never
deletes a potentially referenced upload. Existing/replaced originals are retained.

Create offers **保存草稿** and **发布到实验室**; edits preserve current publication
unless the author explicitly changes it. Failure preserves form values; dismissing
unsaved work requires an application-owned confirmation. Save closes back to the
list and clears `dialog` without racing a second route refresh.

## Preview and viewer contract

The home contact strip reuses this preview for a preview-enabled site that has no
cover. There a cover wins, because it is cheaper than a running page, and only the
newest three on-screen frames run at once (one at widths up to 700px). A site that refuses embedding can give a
blank frame, so give it a cover or a `preview_url` that can be framed.

A preview takes priority over the cover: up to three preview-enabled cards on screen
start their frames once scrolling settles, without hover or focus; at widths up to
700px the budget is one. Visible cards are selected in stable list order. The cover shows
until the frame fires `load`, and remains the fallback when no load event arrives within
12 seconds. Reduced motion keeps posters, and a card without one shows the ◇
placeholder. Preview frames are inert and pointer-transparent, rendered at a
1280px-wide desktop viewport and scaled into the picture. The default 16:10 picture
uses 800px height; mosaic/masonry ratios adjust the frame height rather than stretch
the webpage. Cards waiting for a slot
keep their cover/placeholder and never hold the route wipe. A heavy site can set
a lighter `preview_url`. Leaving the
viewport, hiding the page or opening a dialog unmounts the frames rather than
pretending a hidden frame is paused. On arrival, on-screen frames start at once,
without the scroll settle: a route wipe holds up to 300ms for a coverless card,
then proceeds and the frame fades in whenever it loads. A cover is what guarantees
a picture under the wipe.

Clicking an iframe-mode card opens a native modal filling the browser content
viewport. The blog owns the fixed **返回实验室**, title and **独立打开** toolbar. The
frame owns its content scrolling; the underlying list stays mounted with body
scroll locked. Closing destroys the frame and restores list position/focus, even
after internal iframe navigation. The Page Tools menu yields to this viewer.
Independent-open mode uses an ordinary new-tab link. No Fullscreen API or target
site changes are required. Initial frame state is not transferred from thumbnail
to viewer. Same-origin embedding is refused to preserve the sandbox boundary.

The iframe sandbox permits scripts/same-origin APIs, and in the full viewer forms
and user-opened windows, but not top-level navigation or frame fullscreen. Sensitive
device features are not delegated. Target sites must allow the blog in their
`frame-ancestors`/`X-Frame-Options` policy; the blog cannot override that decision.
Third-party storage/login and some browser features may differ from standalone use.

An iframe `load` event is **not** evidence that its picture rendered successfully:
cross-origin frame failures cannot be reliably detected without target cooperation.
Admin testing is visual confirmation, not an automated compatibility certificate.
The compatibility state after `load` is explicitly `unverified`, never success.
No readiness script or handshake is required of target websites. Observable error
events also restore the cover, but browsers commonly suppress iframe errors: CSP,
X-Frame-Options and network failures can still display a browser error page after
`load`. A timeout only says no load event arrived; it does not prove embedding is
forbidden. Authors should disable the preview and choose independent opening for
known blocked sites. The viewer keeps a **重新加载** action available even after
`load`, alongside the reachable toolbar and independent-open fallback. Escape works
when delivered to the blog; it is not the only exit from a focused cross-origin
frame. No generic cross-origin pause, audio mute, screenshot or DOM access is claimed.

An ordinary iframe has no per-frame User-Agent override. Browser-side previews use
the visitor's browser; changing UA does not override frame policy. A future server-side
Firefox/WebKit screenshot worker could set UA and viewport together, but its cached
images would be snapshots rather than an interactive iframe. No such worker or proxy
is part of this implementation.

## Verification

```sh
node --test apps/api/test/external-projects.test.cjs
npm run test:web
node tests/project-browser.cjs
node tests/project-layouts-browser.cjs
PROJECT_BROWSER=firefox node tests/project-browser.cjs
npm run build:web
```

The browser script uses headless WebKit (or Firefox via `PROJECT_BROWSER`), an isolated CMS fixture, the real API and
Next rewrites, and a second local origin for animated/blocked embeds. It never
uses personal browser sessions or writes production CMS data. Reports, screenshots
and service logs are retained in `test-results/project/` (or `test-results/project-firefox/`).
