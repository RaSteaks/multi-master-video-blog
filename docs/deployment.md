# Deployment Notes

## Windows Local Server

Recommended production layout:

```text
D:\multi-master-video-blog\
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
- Media: local files served by Nginx under `/media/`
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

`setup:cms-schema` installs the `album-cover` and `album-thumb` Directus asset
presets and changes asset transforms to preset-only unless the instance was
already intentionally configured as `all`. The Node asset proxy independently
rejects every transform query except those two preset keys.

For production, replace the Directus admin credentials in API and frontend `.env` files with limited service accounts.
