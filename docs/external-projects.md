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
flag changes only the new collection, fields and cover relation; it does not
rewrite unrelated CMS settings. `external_projects` is included in the private
CMS collection policy. No anonymous Directus collection permissions are needed.

If production shows “实验室暂时无法载入” while local development shows an empty
list, inspect `GET /api/external-projects`. A Directus 403 saying
`external_projects` does not exist or is inaccessible means the production
collection or service permissions are missing, not that there are zero projects.
Run the narrow setup above on the intended deployment if the collection is
missing. If it already exists, verify the API and Web service accounts can read
the listed fields; the authoring API account also needs create/update access.
Keep anonymous Directus access disabled. Manager's Update API + Web installs
dependencies and updates services; it does not run database schema migrations.

Fields: `title`, `description`, `url`, `preview_url`, `preview_enabled`,
`open_mode` (`iframe` or `external`), `cover_image`, `published`, `sort_order`,
`created_at`, and `updated_at`. Lower sort values appear first. Drafts are the
default. Website addresses must be HTTPS without embedded credentials; local
HTTP loopback URLs are accepted only in development for isolated verification.
The API stores URLs and never fetches them or proxies arbitrary website HTML.

## Author workflow and endpoints

The header author menu (`AuthorMenu`) owns **添加网站** and opens
`/project?dialog=create`. The non-authorizing `author_device` hint reveals its
entry; expired sessions sign in and then continue the selected action. No second login system or per-project token is introduced.
The page's author-only **管理网站** control shows published records and drafts.
Its per-card menu edits or changes publication. Sorting is edited in the form.

- `GET /api/external-projects?page=1`: published rows, 24 per page with `hasMore`.
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

Desktop hover/keyboard focus starts the preview after a short dwell; touch selects
one visible card after scrolling settles. Reduced motion keeps posters. Preview
frames are inert and pointer-transparent, rendered at a 1280×800 desktop viewport
and scaled into a 16:10 picture. Only one exhibit runs; leaving/unloading a preview
unmounts its frame rather than pretending a hidden frame is paused.

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
The toolbar and independent-open fallback always remain reachable. Escape works
when delivered to the blog; it is not the only exit from a focused cross-origin
frame. No generic cross-origin pause, audio mute, screenshot or DOM access is claimed.

## Verification

```sh
npm run test:external-projects
npm run test:web
npm run test:project-browser
npm run build:web
```

The browser script uses headless WebKit, an isolated CMS fixture, the real API and
Next rewrites, and a second local origin for animated/blocked embeds. It never
uses personal browser sessions or writes production CMS data. Reports, screenshots
and service logs are retained in `test-results/project/`.
