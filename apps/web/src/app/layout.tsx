import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Keyring — Roles & permissions infrastructure",
  description:
    "Keyring is access-control infrastructure: define actions, compose roles, and grant them to your team.",
  icons: { icon: "/keyring-logo.png", apple: "/keyring-logo.png" },
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
