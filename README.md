# Multi Master Video Blog

Multi Master Video Blog is a self-hosted media blog system designed for creators who need video upload, HLS playback, HDR video support, and multi-master video switching.

## Core Features

- Self-hosted blog
- Video upload support
- HLS video playback
- SDR / HDR10 / HLG / Dolby Vision master switching
- Custom title and description
- CMS-based content management
- Windows local server deployment
- HTTPS domain support
- Existing Nginx integration

## Project Layout

```text
multi-master-video-blog/
├── apps/
│   ├── web/
│   └── cms/
│       └── directus/
├── media/
├── deployment/
│   └── nginx/
└── docs/
```

## Local Development

Install dependencies from the repository root:

```powershell
npm install
```

Run the frontend:

```powershell
npm run dev:web
```

Run the upload/transcode API:

```powershell
npm run dev:api
```

Initialize the local Directus SQLite database:

```powershell
npm run bootstrap:cms
```

Create or repair the Directus content schema:

```powershell
npm run setup:cms-schema
```

Test the local database:

```powershell
npm run test:db
npm run test:cms-schema
npm run test:cms-crud
npm run test:api
```

Run local service health checks:

```powershell
npm run health
```

Run Directus CMS:

```powershell
npm run dev:cms
```

The repository only includes example configuration. Do not commit real `.env` files, SSL certificates, private keys, production database passwords, real domains, or real public IP addresses.

## CMS Content Schema

The second-stage Directus schema contains:

- `posts`: articles with title, slug, summary, Markdown content, cover image, tags, category, publish state, and timestamps.
- `video_projects`: frontend video entries with title, slug, description, cover image, poster image, tags, category, publish state, sort order, and timestamps.
- `video_masters`: playable video versions linked to `video_projects`, including type, HLS URL, codec, resolution, color metadata, default flag, status, and notes.

Relations:

- `posts.cover_image` -> `directus_files`
- `video_projects.cover_image` -> `directus_files`
- `video_projects.poster_image` -> `directus_files`
- `video_masters.project_id` -> `video_projects.id`
- `video_projects.masters` is the Directus one-to-many alias for managing masters from a video project.

## Documentation

- [Project plan](docs/project-plan.md)
- [Frontend pages](docs/frontend.md)
- [Video workflow](docs/video-workflow.md)
- [Upload and transcoding](docs/upload-api.md)
- [Deployment notes](docs/deployment.md)
- [Nginx example](deployment/nginx/README.md)
