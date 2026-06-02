# Directus CMS

This directory contains the CMS application shell for local Directus development.

## First Run

From the repository root:

```powershell
npm install
npm run bootstrap:cms
npm run setup:cms-schema
npm run test:db
npm run test:cms-schema
npm run test:cms-crud
npm run dev:cms
```

Create a local `.env` from `.env.example` before bootstrapping Directus. Keep the real `.env`, database files, uploads, secrets, and production credentials out of Git.

## Planned Collections

- `posts`
- `video_projects`
- `video_masters`

The detailed field plan lives in [../../../docs/project-plan.md](../../../docs/project-plan.md).

## Local Admin

The local development `.env` uses:

```text
admin@example.com
password
```

Change this password before using the CMS beyond local development.
