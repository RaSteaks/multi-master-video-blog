import path from "node:path";
import { fileURLToPath } from "node:url";
import profiles from "../../config/resource-profile.cjs";

const resources = profiles.resolveResourceProfile();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiUrl = (process.env.API_INTERNAL_URL || "http://127.0.0.1:8060").replace(/\/$/, "");

const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const directusUrl = (
  process.env.DIRECTUS_URL ||
  process.env.NEXT_PUBLIC_DIRECTUS_URL ||
  "http://127.0.0.1:8055"
).replace(/\/$/, "");

const directusAdminRoutes = [
  "admin",
  "server",
  "auth",
  "access",
  "users",
  "permissions",
  "roles",
  "policies",
  "collections",
  "fields",
  "relations",
  "items",
  "files",
  "folders",
  "assets",
  "utils",
  "extensions",
  "settings",
  "flows",
  "notifications",
  "comments",
  "activity",
  "presets",
  "dashboards",
  "panels",
  "webhooks",
  "operations",
  "revisions",
  "versions",
  "shares",
  "translations",
  "graphql",
  "websocket"
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone keeps the workspace layout so traced shared modules still resolve.
  ...(process.env.STANDALONE_BUILD === "true" ? { output: "standalone", outputFileTracingRoot: repoRoot } : {}),
  // Keep production builds reliable on the same low-memory hosts used for deployment.
  experimental: {
    cpus: resources.buildWorkers,
    memoryBasedWorkersCount: !resources.enabled,
    // Development/direct-Next uploads must allow a 1 MiB chunk on very slow links.
    // Production Nginx routes /api directly; this matches the browser's chunk deadline.
    proxyTimeout: 300_000
  },
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  async rewrites() {
    return [
      ...directusAdminRoutes.map((route) => ({
        source: `/${route}/:path*`,
        destination: `${directusUrl}/${route}/:path*`
      })),
      {
        source: "/media/:path*",
        destination: `${apiUrl}/media/:path*`
      },
      {
        source: "/api/:path*",
        destination: `${apiUrl}/:path*`
      }
    ];
  }
};

export default nextConfig;
