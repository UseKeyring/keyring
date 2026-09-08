"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  useMyOrganization,
  useMyProfile,
  useMyWorkspaces,
  useOrganizationMutations,
} from "@/hooks/useOrganization";

/*
 * Workspace gate for /dashboard/[orgSlug]: resolves the slug to a workspace
 * the caller belongs to, activates it (driving every org-scoped query + RLS
 * policy), and only then renders the console. Non-members bounce to the
 * root resolver, which picks an owned workspace or onboarding.
 */
export function OrgGate({ orgSlug, children }: { orgSlug: string; children: ReactNode }) {
  const { user, loading } = useAuth();
  const profile = useMyProfile();
  const { orgId } = useMyOrganization();
  const workspaces = useMyWorkspaces();
  const { switchOrganization } = useOrganizationMutations();
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const membership =
    (workspaces.data ?? []).find((w) => w.organizations?.slug === orgSlug) ?? null;
  const ready =
    !loading && !!user && profile.isFetched && !workspaces.isLoading;
  const settled = ready && !!membership && membership.organization_id === orgId && !switching;

  useEffect(() => {
    if (!ready) return;
    if (!membership) {
      router.replace("/dashboard");
      return;
    }
    if (membership.organization_id !== orgId && !switching) {
      setSwitching(true);
      setSwitchError(null);
      switchOrganization(membership.organization_id)
        .catch((err) => {
          const message = err instanceof Error ? err.message : "Could not switch workspace";
          setSwitchError(message);
          toast.error(message);
        })
        .finally(() => setSwitching(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, membership?.organization_id, orgId, attempt]);

  if (switchError && !settled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <div className="flex w-full max-w-md flex-col gap-4 px-4 text-center">
          <p className="text-sm text-muted-foreground">
            Could not switch workspace: {switchError}
          </p>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              className="rounded-md border px-4 py-2 text-sm"
              onClick={() => {
                setSwitchError(null);
                setAttempt((a) => a + 1);
              }}
            >
              Retry
            </button>
            <button
              type="button"
              className="rounded-md border px-4 py-2 text-sm"
              onClick={() => router.replace("/dashboard")}
            >
              Back to workspaces
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!settled) {
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

  return <>{children}</>;
}
