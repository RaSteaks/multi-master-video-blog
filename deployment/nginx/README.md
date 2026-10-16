# Windows Nginx Example

`windows-nginx.example.conf` documents the expected production routing:

- `/` proxies to the frontend app on `127.0.0.1:3000`.
- `/admin/` proxies to Directus on `127.0.0.1:8055`.
- `/api/` proxies to the Node media and article API on `127.0.0.1:8060`.
- `/uploads/` proxies to Directus assets.
- `/media/` proxies to the guarded Node media handler, including playlists and range requests.
- `/manager/` is denied on the public virtual host; Manager requires its own password even on loopback.

Only placeholders are allowed in this repository:

```text
example.com
C:/path/to/fullchain.pem
C:/path/to/privkey.pem
D:/path/to/media/
```

Keep real certificates, private keys, domains, public IPs, database passwords, and backend secrets in the actual server configuration only.

Public ports should be limited to:

```text
80
443
```

Internal-only service ports:

```text
127.0.0.1:3000  frontend
127.0.0.1:8055  Directus
127.0.0.1:8060  media and article API
```

Protected write endpoints use separate tokens:

- `POST /api/uploads/videos` requires `UPLOAD_API_TOKEN`.
- `POST /api/articles` requires `ARTICLE_API_TOKEN` (or falls back to `UPLOAD_API_TOKEN` when intentionally left unset).

Keep both tokens in `apps/api/.env`; never expose them through `NEXT_PUBLIC_*`. The trailing slash in `proxy_pass http://127.0.0.1:8060/;` is required so external `/api/articles` reaches the internal `/articles` route.

Do not add a static `/media/` alias or a separate `.m3u8` location: those would
bypass the application's private-path and symlink checks. See
[`docs/deployment.md`](../../docs/deployment.md#security-update-rollout) for private
scan-file migration, Manager authentication, and removal of historical cached
private responses. Update the actual server configuration when deploying this template.
