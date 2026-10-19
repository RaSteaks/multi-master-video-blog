# syntax=docker/dockerfile:1
# Multi-platform index digests are pinned; native dependencies are installed inside Linux.
ARG NODE_IMAGE=node:22.23.1-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cms/directus/package.json apps/cms/directus/package.json

FROM manifests AS web-build
ENV NODE_OPTIONS=--max-old-space-size=768 npm_config_jobs=1
RUN npm ci --workspace=@multi-master-video-blog/web --include-workspace-root=false --no-audit --no-fund
COPY config config
COPY shared shared
COPY scripts/run-service.cjs scripts/run-service.cjs
COPY apps/web apps/web
ARG RESOURCE_PROFILE=low-2gb
ARG API_INTERNAL_URL=http://api:8060
ARG DIRECTUS_URL=http://cms:8055
ARG NEXT_PUBLIC_SITE_URL=http://localhost:8080
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV RESOURCE_PROFILE=${RESOURCE_PROFILE} API_INTERNAL_URL=${API_INTERNAL_URL} DIRECTUS_URL=${DIRECTUS_URL} \
    STANDALONE_BUILD=true CMS_RUNTIME_ONLY=true NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p apps/web/public && node scripts/run-service.cjs build

FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production CMS_RUNTIME_ONLY=true HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public apps/web/public
COPY --from=web-build --chown=node:node /app/apps/web/content/about.example.md apps/web/content/about.example.md
COPY --chown=node:node config/resource-profile.cjs config/resource-profile.cjs
COPY --chown=node:node scripts/run-service.cjs scripts/run-service.cjs
USER node
CMD ["node", "scripts/run-service.cjs", "web"]

FROM manifests AS api-deps
ENV NODE_OPTIONS=--max-old-space-size=768 npm_config_jobs=1
# System FFmpeg is used at runtime; avoid downloading unused platform-specific binaries.
RUN npm ci --workspace=@multi-master-video-blog/api --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS api
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libvulkan1 mesa-vulkan-drivers ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=api-deps --chown=node:node /app/node_modules node_modules
COPY --from=api-deps --chown=node:node /app/apps/api apps/api
COPY --chown=node:node apps/api/src apps/api/src
COPY --chown=node:node config config
COPY --chown=node:node shared shared
COPY --chown=node:node scripts/run-service.cjs scripts/check-media-tools.cjs scripts/maintenance.cjs scripts/
RUN mkdir -p media .private-media/film-scans apps/api/tmp && chown -R node:node media .private-media apps/api/tmp
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8060 MEDIA_ROOT=/app/media FILM_SCAN_ROOT=/app/.private-media/film-scans FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
USER node
RUN node scripts/check-media-tools.cjs
CMD ["node", "scripts/run-service.cjs", "api"]

FROM directus/directus:11.17.4@sha256:eb326f679ae847c0a776f93b972761dc2ebe84980e0b9d274a6bc31cd62809f7 AS cms
COPY --chown=node:node config /app/config
COPY --chown=node:node scripts/run-service.cjs scripts/setup-directus-schema.cjs scripts/directus-db-utils.cjs scripts/directus-asset-presets.cjs /app/scripts/
ENV SERVICE_CWD=/directus DIRECTUS_CLI=/directus/cli.js NODE_PATH=/directus/node_modules
# Bootstrap is an explicit one-shot command, never a side effect of a service restart.
ENTRYPOINT []
CMD ["node", "/app/scripts/run-service.cjs", "cms"]
