import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Emits a self-contained server bundle with only the dependencies it actually
   * uses, so the runtime container does not have to carry node_modules. It is
   * the difference between an image measured in hundreds of megabytes and one
   * measured in tens, on every deploy and every rollback.
   */
  output: "standalone",

  experimental: {
    serverActions: {
      // Storyboard/reference uploads (images, short video clips) go through
      // server actions, which default to a 1MB body limit.
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
