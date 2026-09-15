"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  slugify,
  useMyOrganization,
  useOrganizationMutations,
} from "@/hooks/useOrganization";
import {
  isSubscribed,
  useInvalidateSubscription,
  useMySubscription,
  usePolarCheckout,
} from "@/hooks/useBilling";
import { Button } from "@keyring/ui/components/button";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import {
  EMPTY_DRAFT,
  OrgSettingsFields,
  type OrgDraft,
} from "../[orgSlug]/settings/org-fields";

export default function NewWorkspacePage() {
  const { user, loading } = useAuth();
  const { org } = useMyOrganization();
  const router = useRouter();
  const [draft, setDraft] = useState<OrgDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const { createOrganization } = useOrganizationMutations();
  const subscription = useMySubscription();
  const checkout = usePolarCheckout();
  const invalidateSubscription = useInvalidateSubscription();
  const subscribed = isSubscribed(subscription.data);
  const patch = (p: Partial<OrgDraft>) => setDraft((d) => ({ ...d, ...p }));

  useEffect(() => {
    if (!loading && !user) router.replace("/auth");
  }, [loading, user, router]);

  // Returning from Polar checkout (?checkout=success): the webhook may still
  // be syncing, so refresh the subscription row and say so.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      toast.success("Payment received — confirming your subscription…");
      invalidateSubscription();
      const url = new URL(window.location.href);
      url.searchParams.delete("checkout");
      url.searchParams.delete("checkout_id");
      window.history.replaceState(null, "", url.toString());
    } else if (params.get("checkout") === "cancelled") {
      toast.info("Checkout cancelled — no charge made.");
      const url = new URL(window.location.href);
      url.searchParams.delete("checkout");
      url.searchParams.delete("checkout_id");
      window.history.replaceState(null, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <span className="type-mono text-ink-muted">loading…</span>
      </div>
    );
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim() || !draft.slug.trim()) {
      toast.error("Name and slug are required");
      return;
    }
    setSaving(true);
    try {
      const created = await createOrganization({
        name: draft.name,
        slug: slugify(draft.slug),
        avatar_url: draft.avatarUrl || null,
        website: draft.website || null,
        support_email: draft.supportEmail || null,
      });
      toast.success("Workspace created");
      router.push(`/dashboard/${created.slug}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create workspace");
    } finally {
      setSaving(false);
    }
  };

  const backHref = org.data?.slug ? `/dashboard/${org.data.slug}` : "/dashboard";

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-16">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <Link
          href={backHref}
          className="type-body-sm flex w-fit items-center gap-1.5 text-ink-muted hover:text-ink"
        >
          <SolarIcon name="reply" className="h-4 w-4" />
          Back to workspace
        </Link>

        <div>
          <h1 className="type-display-sm text-ink">Create workspace</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            Start a fresh workspace to isolate actions, roles and users.
          </p>
        </div>

        {subscription.isLoading ? (
          <div className="type-mono text-ink-muted">checking subscription…</div>
        ) : subscribed ? (
          <div className="w-full">
            <form onSubmit={create} id="new-workspace-form">
              <OrgSettingsFields draft={draft} setDraft={patch} />
            </form>
            <div className="mt-4 flex flex-row items-center gap-2">
              <Button type="submit" form="new-workspace-form" disabled={saving}>
                {saving ? "Creating…" : "Create workspace"}
              </Button>
              <Button type="button" variant="ghost" asChild>
                <Link href={backHref}>Cancel</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-4 rounded-2xl border border-hairline bg-pillar p-6">
            <div>
              <div className="type-body-sm text-ink">
                Creating a workspace requires Pro — $19 per project / month
              </div>
              <p className="type-body-sm mt-1 text-ink-muted">
                Self-hosting stays free forever. On this hosted console, an active Pro or
                Enterprise subscription unlocks workspace creation.
              </p>
            </div>
            {checkout.error && <p className="type-body-sm text-red-500">{checkout.error}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                disabled={checkout.loading}
                onClick={() => void checkout.startCheckout("/dashboard/new")}
              >
                {checkout.loading ? "Opening checkout…" : "Subscribe to Pro"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={subscription.isFetching}
                onClick={() => void subscription.refetch()}
              >
                {subscription.isFetching ? "Checking…" : "I already subscribed — check again"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
