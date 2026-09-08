import type { Metadata } from "next";
import { DashboardChrome } from "../dashboard-chrome";

export const metadata: Metadata = {
  title: "Account — Keyring",
  description: "Your personal sign-in, profile and billing.",
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <DashboardChrome>{children}</DashboardChrome>;
}
