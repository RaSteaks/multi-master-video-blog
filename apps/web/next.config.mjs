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
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  async rewrites() {
    return [
      ...directusAdminRoutes.map((route) => ({
        source: `/${route}/:path*`,
        destination: `${directusUrl}/${route}/:path*`
      })),
      {
        source: "/media/:path*",
        destination: "http://127.0.0.1:8060/media/:path*"
      },
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8060/:path*"
      }
    ];
  }
};

export default nextConfig;
