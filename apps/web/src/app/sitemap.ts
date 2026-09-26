import type { MetadataRoute } from "next";

const siteUrl =
  process.env["NEXT_PUBLIC_APP_URL"] ?? "https://usekeyring.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${siteUrl}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/docs`, changeFrequency: "weekly", priority: 0.9 },
    {
      url: `${siteUrl}/docs/quickstart`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${siteUrl}/docs/typescript-sdk`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${siteUrl}/docs/api-reference`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    { url: `${siteUrl}/pricing`, changeFrequency: "monthly", priority: 0.7 },
  ];
}
