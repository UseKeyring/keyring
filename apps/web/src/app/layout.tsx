import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  metadataBase: new URL("https://keyring.sh"),
  title: "Keyring — Roles & permissions infrastructure",
  description:
    "Keyring is access-control infrastructure: define actions, compose roles, and grant them to your team.",
  icons: { icon: "/keyring-logo.png", apple: "/keyring-logo.png" },
  openGraph: {
    type: "website",
    title: "Keyring — Access control infrastructure for your product",
    description:
      "Define actions, compose them into roles, and grant them to your product's users.",
    images: [{ url: "/opengraph.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Keyring — Access control infrastructure for your product",
    description:
      "Define actions, compose them into roles, and grant them to your product's users.",
    images: ["/opengraph.png"],
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
