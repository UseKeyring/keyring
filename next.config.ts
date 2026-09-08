import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Off: workspace URLs are dynamic (/dashboard/[orgSlug]/…), which static
  // route typing cannot express. Route safety comes from the useDashboardBase
  // helper + NavEntry builders instead of literals.
};

export default nextConfig;
