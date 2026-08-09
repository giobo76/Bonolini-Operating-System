import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@bos/ui", "@bos/auth", "@bos/core", "@bos/db", "@bos/jobs"],
};

export default nextConfig;
