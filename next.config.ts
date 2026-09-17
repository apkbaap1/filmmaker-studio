import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Storyboard/reference uploads (images, short video clips) go through
      // server actions, which default to a 1MB body limit.
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
