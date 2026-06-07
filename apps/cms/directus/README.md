# Directus CMS

This directory contains the CMS application shell for local Directus development.
The current project default is PostgreSQL. SQLite is kept as a legacy/local fallback and migration source.

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

Create a local `.env` from `.env.example` before bootstrapping Directus, then set the PostgreSQL password for `DB_PASSWORD`. Keep the real `.env`, database files, uploads, secrets, and production credentials out of Git.

## SQLite to PostgreSQL Migration

For a full migration that preserves Directus users, roles, permissions, files, and content:

1. Stop Directus.
2. Back up SQLite and uploads:
   ```powershell
   New-Item -ItemType Directory -Force backups
   Copy-Item apps\cms\directus\database\data.db backups\directus-sqlite-data.db
   Copy-Item apps\cms\directus\uploads backups\directus-uploads -Recurse
   ```
3. Back up the target PostgreSQL database:
   ```powershell
   pg_dump -Fc -f backups\postgres-before-directus-migration.dump <database>
   ```
4. Update `apps/cms/directus/.env` from SQLite to PostgreSQL settings.
5. Initialize the PostgreSQL Directus schema:
   ```powershell
   npm run bootstrap:cms
   npm run dev:cms
   ```
6. In another terminal, create the content schema:
   ```powershell
   npm run setup:cms-schema
   ```
7. Stop Directus again.
8. Replace PostgreSQL data with the SQLite export:
   ```powershell
   npm run migrate:cms:postgres -- --confirm-replace
   ```
9. Start Directus and verify:
   ```powershell
   npm run test:db
   npm run test:cms-schema
   npm run test:cms-crud
   npm run health
   ```

The migration script truncates all tables in the configured PostgreSQL schema, imports every SQLite table, preserves IDs, resets PostgreSQL sequences, and verifies row counts. It refuses to run without `--confirm-replace`.

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
