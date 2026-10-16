# Deployment Notes

## Windows Local Server

Recommended production layout:

```text
D:\path\to\project\
├── apps\
│   ├── web\
│   └── cms\
├── media\
├── deployment\
└── docs\
```

## Runtime Services

- Frontend: Next.js on `127.0.0.1:3000`
- CMS: Directus on `127.0.0.1:8055`
- Upload API: Node.js service on `127.0.0.1:8060`
- Media: Nginx forwards `/media/` to the Node API's guarded file handler
- HTTPS: configured manually in Windows Nginx

## Security Checklist

- Require login for CMS access.
- Do not expose the database directly to the public internet.
- Do not commit `.env` files.
- Do not commit SSL certificates or private keys.
- Disable directory browsing for media paths.
- Open only required public ports, normally `80` and `443`.
- Back up the database and media directory regularly.

## Nginx

Use `deployment/nginx/windows-nginx.example.conf` as a reference only. Put real production values in the actual Nginx configuration directory on the server, not in this repository.

## Production Commands

Apply the CMS model and run the release checks:

```powershell
npm run setup:cms-schema
npm run test:cms-schema
npm run test:cms-crud
npm run test:api
npm run test:album-api
npm run test:web
npm run build:web
```

Start local services:

```powershell
powershell -ExecutionPolicy Bypass -File deployment/windows/start-services.ps1
```

Stop local services:

```powershell
powershell -ExecutionPolicy Bypass -File deployment/windows/stop-services.ps1
```

Run health checks:

```powershell
npm run health
```

## Upload API Security

Set a strong `UPLOAD_API_TOKEN` in `apps/api/.env`. Keep `8060` bound to `127.0.0.1` and expose uploads through Nginx `/api/` only.

The same token protects album creation, album editing, photo uploads, cover
selection, reordering, publication changes, and deletion. It is entered in
the page component and must never be placed in a `NEXT_PUBLIC_*` variable,
URL, cookie, or browser storage.

For album uploads, configure:

```env
MAX_ALBUM_UPLOAD_BYTES=536870912
MAX_ALBUM_IMAGE_BYTES=67108864
MAX_ALBUM_PHOTOS=24
```

Set Nginx `client_max_body_size` to at least the complete-request limit and
allow enough proxy time for 512 MiB uploads. After changing API environment
variables, restart both runtime services:

```powershell
npm run api:restart
npm run web:restart
npm run health
```

`setup:cms-schema` installs named WebP presets for album thumbnails, content
cards, article/video hero images, and full-size/thumbnail site backgrounds. It
changes asset transforms to preset-only unless the instance was already
intentionally configured as `all`. The Node asset proxy independently rejects
arbitrary transform parameters and only accepts these managed preset keys.

The example Nginx config enables gzip for text/JSON responses and streams large
multipart requests directly to Node. Media requests also pass through Node's
canonical-path checks, preserving byte ranges and HLS cache headers. Do not add
a separate static media alias or playlist location that bypasses these checks.

For production, replace the Directus admin credentials in API and frontend `.env` files with limited service accounts.

## Security update rollout

- Set `MANAGER_AUTH_PASSWORD` to a strong password in the repository-root `.env`
  or the Manager process environment; `MANAGER_AUTH_USERNAME` defaults to `admin`.
  Without a password, its HTTP interface returns 503. Local CLI service-control
  commands remain available. The public Nginx example denies `/manager/`; use a
  private administration endpoint if remote access is needed. If proxying it,
  preserve `Host` and retain Manager authentication. Reload the page after a
  Manager restart because its CSRF nonce changes. Every POST requires the page's
  `X-Manager-CSRF` header and `Content-Type: application/json`.
- Film-scan originals, review previews and rollback journals now live in
  `MEDIA_ROOT/../.private-media/film-scans` by default. `FILM_SCAN_ROOT` can override
  this location but must resolve outside the public media tree. Back up the old
  directory before upgrading. At API startup, all numeric job directories under
  legacy `MEDIA_ROOT/film-scans` are moved without overwriting existing destinations,
  before listening. Existing videos using the `film-scans` slug retain their
  `source`/`sdr`/HDR directories and public URLs.
  Database paths keep the logical `film-scans/...` format, including old Windows
  separators. A collision or cross-volume rename stops startup with an error;
  reconcile/move the remaining files to the private root before restarting.
- Update the actual Nginx media routing together with the API. The new template
  has no raw filesystem alias, so private files cannot bypass Node through an
  alternate Windows path or symlink. Remove old private-file copies from all
  public roots after verifying backups/migration, and purge previously cached
  `/media/film-scans/*`, `/api/media/film-scans/*` and private asset responses from
  any reverse-proxy/CDN caches. New code cannot recall bytes already downloaded.
- Public `/api/assets/:id` reads require a published owner or a site background
  reference. The API service account needs read access to the relevant content
  collections as well as files. Denied collections grant no access; CMS outages
  fail closed. Article and upload tokens allow previews only for their respective
  article or video/album content. The editor/gallery fetch draft images into
  memory using authorization headers. Public responses revalidate authorization;
  authenticated responses use `private, no-store`.
  For CMS files used only in local `content/about.md` or `SITE_HOME_AVATAR_URL`,
  explicitly list their IDs in the API's comma-separated `PUBLIC_ASSET_IDS`;
  these are intentional public exceptions and must be removed there to revoke
  access. New article cover and inline uploads have a service-written
  `description=article-image:<UUID>` provenance marker; a Markdown link alone
  cannot grant access to an unrelated file. Older inline images lack this proof:
  an administrator must verify their article ownership and set that marker in
  Directus before they can be reused privately. Do not automatically adopt IDs
  from untrusted Markdown or add private draft images to `PUBLIC_ASSET_IDS`.
  `DIRECTUS_SHOW_DRAFTS=true` continues to serve referenced draft post/video
  images through a separate, non-cacheable Next preview route. This explicitly
  exposes draft content as before; keep the flag false on the public site.
- Video covers now use the article image type/signature and size limits. Existing
  non-image assets are forced to download with a sandbox CSP and `nosniff`.
  Health checks share cached FFmpeg/FFprobe availability for 60 seconds, with a
  five-second deadline per probe; they are not a real-time codec diagnostic.

The offline security regression checks are `npm run test:security`. They use
temporary files and mocked CMS/service effects; they do not alter live services.
