/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/media/:path*",
        destination: "http://127.0.0.1:8060/media/:path*"
      }
    ];
  }
};

export default nextConfig;
