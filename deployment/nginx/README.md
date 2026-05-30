# Windows Nginx Example

`windows-nginx.example.conf` documents the expected production routing:

- `/` proxies to the frontend app on `127.0.0.1:3000`.
- `/admin/` proxies to Directus on `127.0.0.1:8055`.
- `/api/` proxies to the upload/transcode API on `127.0.0.1:8060`.
- `/uploads/` proxies to Directus assets.
- `/media/` maps to the local HLS media directory.

Only placeholders are allowed in this repository:

```text
example.com
C:/path/to/fullchain.pem
C:/path/to/privkey.pem
D:/multi-master-video-blog/media/
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
127.0.0.1:8060  upload API
```

The upload API requires `UPLOAD_API_TOKEN` for `POST /api/uploads/videos`.
