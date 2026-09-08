"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useMyOrganization, useMyWorkspaces } from "@/hooks/useOrganization";
import { useMyProfile } from "@/hooks/useOrganization";

/*
 * /dashboard resolves to the caller's workspace: active workspace first,
 * then the earliest membership, else onboarding. Every workspace-scoped
 * page lives under /dashboard/[orgSlug].
 */
export default function DashboardRoot() {
  const { user, loading } = useAuth();
  const profile = useMyProfile();
  const { orgId } = useMyOrganization();
  const workspaces = useMyWorkspaces();
  const router = useRouter();

  useEffect(() => {
    if (loading || !user || !profile.isFetched || workspaces.isLoading) return;
    const mine = workspaces.data ?? [];
    const active = mine.find((w) => w.organization_id === orgId) ?? mine[0];
    const slug = active?.organizations?.slug;
    router.replace(slug ? `/dashboard/${slug}` : "/onboarding");
  }, [loading, user, profile.isFetched, workspaces.isLoading, workspaces.data, orgId, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <div className="flex w-full max-w-3xl animate-pulse flex-col gap-4 px-4" aria-hidden>
        <div className="h-7 w-48 rounded-sm bg-gray-100 dark:bg-polar-700" />
        <div className="h-4 w-72 max-w-full rounded-sm bg-gray-100 dark:bg-polar-700" />
        <div className="mt-2 h-40 w-full rounded-2xl bg-gray-100 dark:bg-polar-800" />
      </div>
    </div>
  );
}
