import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

const siteUrl =
  process.env["NEXT_PUBLIC_APP_URL"] ?? "https://usekeyring.dev";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Keyring — Roles & permissions infrastructure",
  description:
    "Keyring is access-control infrastructure: define actions, compose roles, and grant them to your team.",
  icons: { icon: "/keyring-logo.png", apple: "/keyring-logo.png" },
  openGraph: {
    type: "website",
    siteName: "Keyring",
    url: siteUrl,
    title: "Keyring — Access control infrastructure for your product",
    description:
      "Define actions, compose them into roles, and grant them to your product's users.",
    images: [
      {
        url: `${siteUrl}/opengraph.png`,
        width: 1200,
        height: 630,
        alt: "Keyring — Access-control infrastructure for your product",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Keyring — Access control infrastructure for your product",
    description:
      "Define actions, compose them into roles, and grant them to your product's users.",
    images: [`${siteUrl}/opengraph.png`],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="scroll-smooth">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
