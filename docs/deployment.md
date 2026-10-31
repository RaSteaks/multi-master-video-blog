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

## Next.js security update (2026-10-22)

The Web workspace pins Next.js 16.4.1 and its lockfile resolves the Next.js image
decoder to Sharp 0.35.5. Install from the updated lockfile and create a new
production build; restarting an old `.next` build does not apply this update.

For the Windows deployment, stop Web before replacing its installed dependencies,
run `npm install --workspace @multi-master-video-blog/web --include-workspace-root=false`,
then run `npm run web:rebuild-restart` in Production mode. For a development
instance, restart Web after installing instead. For Linux/systemd, build a fresh
release using the configured environment and restart `video-blog-web`; for Docker,
rebuild the Web image and recreate the `web` container using the deployment's
existing Compose files and environment.

This isolated Web dependency update requires **Web to restart**. API, Directus,
PostgreSQL, Manager and Nginx do not need restarting for this commit. Later API,
CMS or proxy changes have their own deployment requirements. Installation/build
commands must run on the deployment host; a Git push alone does not update a
running process.

Web 工作区固定 Next.js 16.4.1，其图像解码依赖锁定为 Sharp 0.35.5。部署时必须
安装新锁文件中的依赖、重新构建并重启 **Web**；直接重启旧 `.next` 构建不会生效。
Windows 生产环境先停止 Web、安装 Web workspace 依赖，再执行
`npm run web:rebuild-restart`。Linux 重启 `video-blog-web`；Docker 重新构建并替换
`web` 容器。仅此提交无需重启 API、CMS、PostgreSQL、Manager 或 Nginx。

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

Production Web builds use `apps/web/tsconfig.build.json`, which inherits the
normal strict settings and excludes only `node_modules` and `.next/dev/types`.
Development keeps `tsconfig.json`; `NEXT_TSCONFIG_PATH` still overrides both for
isolated fixtures. This prevents validators from an earlier `next dev` session
from referencing deleted layouts during a later production build. Source files
and the current `.next/types` production validators are still type-checked.
Run `node --test tests/web-build-types.test.cjs` for the regression checks.

When diagnosing a type-check failure through Manager, inspect
`logs/web.build.out.log` as well as `logs/web.build.err.log`: the TypeScript CLI
writes diagnostics to standard output. After correcting a failed build, use
**Build + Restart** / `npm run web:rebuild-restart` before attempting Web Start.

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

## Manager service controls

Manager controls PostgreSQL, Directus CMS, Upload API and Frontend Web. Its page
and CLI share the same lifecycle functions and cross-process operation lock.
The Manager itself is separate: update its code with `npm run manager:restart`,
then sign in again to obtain a new session and CSRF nonce. Do this after any active
service operation finishes. These controls target the Windows deployment.

| Service | Start | Stop | Restart | Inspect |
| --- | --- | --- | --- | --- |
| PostgreSQL | `npm run postgres:start` | `npm run postgres:stop` | `npm run postgres:restart` | `postgres:status`, `postgres:health` |
| Directus CMS | `npm run cms:start` | `npm run cms:stop` | `npm run cms:restart` | `cms:status`, `cms:health` |
| Upload API | `npm run api:start` | `npm run api:stop` | `npm run api:restart` | `api:status`, `api:health` |
| Frontend Web | `npm run web:start` | `npm run web:stop` | `npm run web:restart` | `web:status`, `web:health` |

Run the inspect aliases with `npm run` as well. All aliases invoke
`node scripts/service-control.cjs <service> <action>`; existing PowerShell
wrappers remain available, with a 90-second default startup-health deadline.
PostgreSQL control may require an Administrator terminal/Manager process.

- **Start** is idempotent and waits for process HTTP health. An occupied but
  unhealthy port fails rather than being reported as a successful start.
- **Stop** waits for the service/port to stop. The UI disables it for a stopped
  service, while the CLI still accepts an idempotent stop.
- **Restart** stops then starts the selected service. Production Web reuses its
  existing `.next/BUILD_ID` build; ordinary Start/Restart never build implicitly.
  A missing production build reports the corrective command.
- **Build + Restart** / `npm run web:rebuild-restart` stops Web, runs `build:web`,
  starts it and waits for health. It is available only in Production mode; use
  Restart in Development or switch to Production. A build failure leaves Web
  stopped and does not start an incomplete bundle. Inspect the **Build** log,
  fix the build and run Build + Restart again.
- **Update API + Web** / `npm run services:update` stops Web and API, installs
  their workspace dependencies, builds production Web, then starts API followed
  by Web with health checks. Development skips the build. Installation uses
  `npm install --workspace=@multi-master-video-blog/api --workspace=@multi-master-video-blog/web --include-workspace-root=false --include=dev --no-audit --no-fund`
  from the project root, honoring the checked-in package manifests and lockfile.
  It deliberately avoids `npm ci`, which removes the shared dependency tree.
  PostgreSQL and CMS are not restarted; CMS-only and root dependency updates
  still require a separate maintenance procedure. Registry access and write
  permissions for the project are required. Manager does not pull Git changes.
  Every failure stops subsequent steps; install/build failure leaves both API
  and Web stopped. Fix the error, then retry Update API + Web. The persistent
  operation panel reports installation progress; **Dependencies** displays
  `logs/app.dependencies.out.log` and `logs/app.dependencies.err.log`.
  After deploying this controller change, restart Manager once to load it;
  merely clicking Update in an already-running older Manager uses the old flow.
  Regression checks: `npm run test:manager` covers sequencing, failures and
  offline fixture package installation; `node tests/manager-update-browser.cjs`
  checks the authenticated UI with isolated, simulated Windows service effects.
  Browser evidence is saved in `test-results/manager-auto-install`.
- `npm run services:start` starts PostgreSQL → CMS → API → Web, stopping on the
  first failed startup. `services:stop` attempts Web → API → CMS → PostgreSQL,
  retaining every failure. `services:restart` performs both phases and tries to
  restore service availability even if a stop failed; the overall result still
  reports that failure. `services:status` / `services:health` inspect the stack.
- Single-service actions do not silently restart dependent services. Stop/restart
  confirmation explains the interruption; finish uploads/conversions first.

### API upload-storage lock after a Windows restart

Windows force-stop can leave the upload spool's lock directory behind. Its lease
expires after 30 seconds without the owning API's heartbeat. API startup now
waits and retries for up to 35 seconds before failing; the Manager's default
90-second health deadline allows this recovery. Do not lower that deadline below
the lock recovery window. A live owner's heartbeat continues to block a second
API process: the retry does not delete or override an active lock.

`ELOCKED` / `Lock file is already being held` is a storage-ownership conflict,
not evidence of missing Directus schema. If it persists, stop duplicate API
instances sharing `VIDEO_UPLOAD_ROOT` and retry; do not manually delete their
active lock or run schema changes to address this error. For an older deployed
API, after confirming that its previous process has exited, wait at least
35 seconds before starting it again. Never delete the upload directory: it holds
resumable upload data.

Service, stack and Web-mode POST endpoints return **202** once the operation lock
is acquired, with `{ok:true, operation:{id,...}}`. This is acceptance, not success.
Poll authenticated `GET /api/operations/<id>` for `running`, `succeeded`, `failed`
or `interrupted`; `/api/status` also includes the latest operation. Conflicting
commands return 409. The CLI continues to wait and returns a nonzero exit code
on failure, including partial stack results.

The UI shows named per-service phases, keeps refresh/log viewing available, and
disables duplicate mutations. Refreshing or closing the page does not cancel
work. The **当前任务** list covers PostgreSQL, CMS, API and Web commands, including
stack actions, and shows the active service phase (for example, “当前正在重启web”).
The shared lock allows one command at a time. Finished tasks leave this list;
their result remains in the operation detail panel. Connection failures mark the
displayed task state as unconfirmed instead of implying completion.
The latest bounded record is saved to `logs/service-operation.json`, so CLI
operations and page reloads share progress. The current process also retains up
to 12 recent records. A controller crash without a recorded result is shown as
interrupted once its lock is released/stale. An interrupted or unreachable
operation is not automatically retried: refresh actual service state first.
The journal excludes credential request/result fields and is not an audit log.

## Upload API Security

Set a strong `UPLOAD_API_TOKEN` in `apps/api/.env`. Keep `8060` bound to `127.0.0.1` and expose uploads through Nginx `/api/` only.

The same token protects album creation, album editing, photo uploads, cover
selection, reordering, publication changes, and deletion. It is entered in
the page component and must never be placed in a `NEXT_PUBLIC_*` variable,
URL, cookie, or browser storage.

The author menu exchanges this token for a fixed six-hour in-memory session.
Only a random session ID is sent in the HttpOnly `author_session` cookie
(`Path=/api`); the API stores its SHA-256 digest. The readable `author_hint`
cookie is only a client-side hint and never grants access. Opening or returning
to a browser window checks the server session even if readable hints are missing;
a valid session also restores the author controls. The persistent session cookie
survives browser restarts within its original six-hour expiry, provided the browser
retains site cookies and the API process remains running. Session responses
are `no-store`; public page rendering does not read session or device cookies. Up to 16
devices may be signed in; another login evicts the oldest session.

Successful login also writes `author_device=1` server-side with `Path=/`,
`SameSite=Strict`, `Max-Age=31536000` and `Secure` on HTTPS, without HttpOnly.
This non-secret hint only reveals the client-rendered author icon; it grants no
API permission. Expiry and ordinary logout retain it. “退出并忘记此设备” clears
it, including after session expiry. New devices sign in through `/studio` or
Cmd/Ctrl+Alt+Shift+L; `/studio?next=/albums` resumes a local path after login.
The keyboard handler uses physical `KeyL` because Option changes the character
reported by some Mac layouts. Native Safari shortcut verification requires
Safari's “Allow remote automation”; WebKit page tests do not verify its app menu.
External and protocol-relative return URLs are ignored. The studio route is
noindex and omitted from navigation/sitemap. Keep it reachable through Nginx.

Public PageTools no longer contain login/upload actions. The author icon lives
beside Appearance (home: to its left), and the global file-drop layer is enabled
only with a valid session. Page management affordances use the same device hint.

The homepage has one fixed laboratory link to `/project`, so project edits never
need to invalidate it. Failed CMS reads propagate to ISR, which retains the last
successful homepage. A cold build requires a reachable CMS. `CMS_RUNTIME_ONLY=true` continues to opt deployments into runtime
rendering intentionally; normal builds with positive cache revalidation retain a
static homepage. `npm run test:phase6-cache` verifies a production build, failed
CMS revalidation retaining good data, and recovery after project invalidation.
The former home upload-link environment overrides are removed.

Whole-player fullscreen retains master controls. Standard native-video fullscreen
is promoted to the whole player when the browser permits; Firefox's stacked
fullscreen elements are unwound together on exit. Firefox's native controls use a
privileged double-click handler ([Mozilla implementation](https://github.com/mozilla/gecko-dev/blob/master/toolkit/content/widgets/videocontrols.js)),
so interception alone is insufficient. If promotion is refused, or iOS uses its
native video-only API, that fallback remains synchronized but cannot show master
controls; the site's fullscreen button retains the complete player. iPhone falls back to
page immersion, Android attempts landscape locking, and touch landscape playback
uses immersion. Physical device rotation, safe areas and HDR output require device
validation. These modes pause the liquid background without changing saved speed.
Run `npm run test:create-menu-browser` for author/upload regressions and
`npm run test:phase6-browser` for public tools, homepage and playback checks.
Both use disposable localhost fixtures and headless WebKit;
`PHASE6_BROWSER=firefox npm run test:phase6-browser` selects headless Firefox.
Evidence is saved under `test-results/create-menu` and `test-results/phase6-<browser>`.
Run `node tests/author-session-browser.cjs` for browser restart, missing display
hints and cross-window logout regressions. It uses a disposable persistent WebKit
profile; `AUTHOR_BROWSER=firefox` selects Firefox. Evidence is saved under
`test-results/author-session-<browser>`.

API process termination revokes every author session. Manager saves token
settings before restarting the API: if it reports `restartOk: false`, confirm
the old process has stopped before treating all sessions as revoked. Signing
out revokes only the current browser session (shared by its tabs).

For proxied browser login, enable `TRUST_PROXY=true` only while the API is
private. Nginx must overwrite `X-Forwarded-Host` (including the public port)
and `X-Forwarded-Proto`; the supplied templates do this, and Next rewrites
preserve the original host. HTTPS adds `Secure` to all author cookies. Login requires
a same-origin JSON request; logout also requires the session's `X-Author-CSRF`.
Tokens are never logged, persisted by the site, or returned to the browser.
Video, album, photo and film-scan requests accept either the original token or
an author session with `X-Author-CSRF`. An explicitly entered token takes
precedence; an invalid token never silently falls back to the session. Article
requests accept the session only when `ARTICLE_API_TOKEN` is unset and actually
inherits the upload token. An explicitly configured identical value still keeps
the article boundary separate; its placeholder disables publication. Maintenance
control remains token-only. Upload forms preserve manual credential entry and
retain selected files/text when a session expires.

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
  preserve `Host` and retain Manager authentication. Browser visits redirect to
  `/manager/login` (or `<MANAGER_BASE_PATH>/login`) and use the same configured
  account and password. Basic authentication is disabled for all HTTP routes so
  it cannot bypass login throttling. API clients must sign in at `/api/login`
  with the login page's nonce and retain its cookie before reading the dashboard
  mutation nonce. Local CLI service-control commands are unaffected.
  The login creates a random, server-held session with an 8-hour lifetime in an
  `HttpOnly; SameSite=Strict` cookie scoped to the Manager base path. HTTPS proxies
  must replace `X-Forwarded-Proto` with `https` so the cookie also uses `Secure`.
  Sessions are revoked on logout or Manager restart; at most 32 are retained.
  Logout leaves accepted service operations running. Expired browser sessions
  return to the login page. Ten failed login attempts within five minutes pause
  login until that window ends; the budget is shared by this single-account
  console, including behind a proxy.
  Unauthenticated requests also share a limit of 120 per minute; `429` responses
  include `Retry-After`. Existing sessions remain usable during anonymous request
  throttling. These in-memory limits reset on Manager restart and are lightweight
  abuse controls, not protection against network saturation or distributed attacks.
  Login accepts only `username` (1–128 characters) and `password` (1–512 characters)
  strings in a JSON body of at most 4096 bytes. No SQL or shell command is built
  from credentials. Malformed JSON errors never echo submitted credential text.
  Every POST requires the page's `X-Manager-CSRF` header and
  `Content-Type: application/json`. The public login page uses a separate nonce
  that cannot authorize service mutations; the dashboard nonce belongs to its
  particular session and changes on each login. If another tab logs in and rotates
  the shared cookie, an older page's next POST is rejected with `403` and
  `MANAGER_CSRF_MISMATCH`. The page reloads its session nonce and asks the operator
  to confirm the action again; it never automatically replays the rejected command.
  Login errors preserve the account
  name and do not distinguish an unknown account from an incorrect password.
  HTML responses permit only their hashed inline script, deny framing and third-party
  connections, and all responses disable MIME sniffing and request search-engine
  exclusion. Header/body timeouts bound incomplete requests. Search-engine directives
  are advisory; authentication and throttling enforce access on the server.
  Browser breakpoints and modified responses cannot be prevented by a website and
  never grant server permissions. Use HTTPS for remote administration: these checks
  do not encrypt plain HTTP or protect a stolen valid session on a compromised device.
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

## Linux and Docker

For native systemd and Docker Compose deployment on 1–2 core, 2–4GB Linux hosts,
see [Linux low-resource deployment](linux-deployment.md). It covers shared resource
profiles, persistent storage, explicit initialization, on-host maintenance builds,
rollback, and the remaining Linux/Vulkan acceptance checks.
