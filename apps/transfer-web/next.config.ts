import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@bos/ui", "@bos/core", "@bos/auth", "@bos/db", "@bos/jobs"],
};

export default nextConfig;
