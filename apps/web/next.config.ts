import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

import path from "node:path";

const withMDX = createMDX();

const nextConfig: NextConfig = {
  // Off: workspace URLs are dynamic (/dashboard/[orgSlug]/…), which static
  // route typing cannot express. Route safety comes from the useDashboardBase
  // helper + NavEntry builders instead of literals.
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  transpilePackages: ["@keyring/ui"],
};

export default withMDX(nextConfig);
