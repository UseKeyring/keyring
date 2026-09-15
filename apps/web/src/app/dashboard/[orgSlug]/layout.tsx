import type { Metadata } from "next";
import { DashboardChrome } from "../dashboard-chrome";
import { OrgGate } from "./org-gate";

export const metadata: Metadata = {
  title: "Console — Keyring",
  description: "Manage actions, roles and grants for your workspace.",
};

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return (
    <OrgGate orgSlug={orgSlug}>
      <DashboardChrome>{children}</DashboardChrome>
    </OrgGate>
  );
}
