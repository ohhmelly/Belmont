import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Slim, self-contained build output for the Docker image.
  output: "standalone",
  // Cache Components (Next 16's experimental per-component caching) treats
  // any dynamic route (session/cookie/DB reads, like /dashboard here) as an
  // error unless wrapped in extra Suspense/"use cache" ceremony. This app
  // is a classic dynamic server-rendered app, so that feature is off.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
