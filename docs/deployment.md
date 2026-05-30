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

Build the frontend:

```powershell
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

For production, replace the Directus admin credentials in API and frontend `.env` files with limited service accounts.
