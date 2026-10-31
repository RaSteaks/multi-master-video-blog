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

## Repair a deployed Insights aggregation

`Cannot query field "undefined" on type "video_projects_aggregated"` can occur
when a line-chart panel has no aggregation function. Panel options live in the
Directus database, so rebuilding Web or restarting services does not fill in this
setting. In the dashboard editor, select the panel's **Aggregation** explicitly;
for a video project count, use **Count** and Y axis **id**, then save the panel and
dashboard.

For a Windows deployment, update the repository files and run these commands in
PowerShell from the deployed project root while CMS is running. The repair uses
`apps/cms/directus/.env` and process environment overrides, matching the server's
`DIRECTUS_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`. Set `DIRECTUS_ENV_PATH` if
the deployment uses a different CMS environment file.

```powershell
# Inspect affected line-chart panels; this does not change CMS configuration.
npm run repair:cms-insights

# Replace PANEL_ID with the id printed above and choose the intended function.
npm run repair:cms-insights -- --panel-id PANEL_ID --aggregation count

# Apply only that panel's repair after reviewing the preview.
npm run repair:cms-insights -- --panel-id PANEL_ID --aggregation count --apply
```

The default is inspection only. Applying requires an explicit panel and function,
verifies the aggregate against the deployed GraphQL schema, saves the original
panel to `backups/directus-insights/`, and reads back the saved configuration.
Existing valid aggregations are left unchanged. The repair preserves the panel's
filters, axes, display settings, and dashboard layout. Refresh Insights afterward;
no service restart or full schema setup is needed. The check validates the chosen
aggregate, not every chart grouping or filter.

## Video source format upgrade

The video detail page requests `video_masters.source_format`, a nullable JSON
field shown as **Source Format** in the CMS. When this field is missing, Directus
returns 403 even for an administrator. With the existing CMS running, apply and
verify just this field before restarting the application:

```powershell
npm run setup:video-source-format
npm run cms:restart
npm run api:restart
npm run web:restart
```

The command is safe to repeat and preserves existing records and permissions.
For a restricted Web account, also grant read access to this field in its existing
policy. New installations can use `npm run setup:cms-schema`, which includes the
same field and verification. Existing values can remain empty; the optional
`npm run backfill:video-source-formats` command previews recoverable source metadata.

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
