const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  async rewrites() {
    return [
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
