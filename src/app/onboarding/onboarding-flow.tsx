"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  slugify,
  useMyJoinRequest,
  useMyOrganization,
  useOrganizationMutations,
} from "@/hooks/useOrganization";
import {
  isSubscribed,
  useInvalidateSubscription,
  useMySubscription,
  usePolarCheckout,
} from "@/hooks/useBilling";
import { KeyringMark } from "@/components/ui/keyring-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WaitlistBlocked, useWaitlistApproved } from "@/components/waitlist-gate";
import {
  EMPTY_DRAFT,
  OrgSettingsFields,
  type OrgDraft,
} from "../dashboard/[orgSlug]/settings/org-fields";

type Mode = "create" | "join";

const MODES = [
  {
    value: "create",
    title: "Create new",
    description: "Start a fresh workspace. Requires a Pro subscription.",
  },
  {
    value: "join",
    title: "Request to join",
    description: "Know a workspace slug? Send a join request — a manager must approve it.",
  },
] as const;

export function OnboardingFlow() {
  const { user, loading, signOut } = useAuth();
  const { profile, orgId } = useMyOrganization();
  const router = useRouter();

  const [mode, setMode] = useState<Mode>("create");
  const [draft, setDraft] = useState<OrgDraft>(EMPTY_DRAFT);
  const [joinSlug, setJoinSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const { createOrganization, requestJoinOrganization, withdrawJoinRequest } =
    useOrganizationMutations();
  const myRequest = useMyJoinRequest();
  const subscription = useMySubscription();
  const checkout = usePolarCheckout();
  const invalidateSubscription = useInvalidateSubscription();
  const subscribed = isSubscribed(subscription.data);
  const patch = (p: Partial<OrgDraft>) => setDraft((d) => ({ ...d, ...p }));
  const gate = useWaitlistApproved(user?.email);
  const gated = gate.enabled && !!user && !gate.checking && !gate.approved;

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
      window.history.replaceState(null, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loading && user && profile.isFetched && orgId) router.replace("/dashboard");
  }, [loading, user, profile.isFetched, orgId, router]);

  if (loading || !user || !profile.isFetched || orgId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="type-mono text-ink-muted">loading…</span>
      </div>
    );
  }

  if (gated) return <WaitlistBlocked email={user?.email} />;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim() || !draft.slug.trim()) {
      toast.error("Name and slug are required");
      return;
    }
    setSaving(true);
    try {
      await createOrganization({
        name: draft.name,
        slug: slugify(draft.slug),
        avatar_url: draft.avatarUrl || null,
        website: draft.website || null,
        support_email: draft.supportEmail || null,
      });
      toast.success("Workspace ready");
      router.replace("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create organization");
    } finally {
      setSaving(false);
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinSlug.trim()) return;
    setSaving(true);
    try {
      await requestJoinOrganization(joinSlug);
      setJoinSlug("");
      toast.success("Request sent — a workspace manager must approve it");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not request to join");
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async () => {
    if (!myRequest.data) return;
    setSaving(true);
    try {
      await withdrawJoinRequest(myRequest.data.id);
      toast.success("Request withdrawn");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not withdraw request");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <div className="relative hidden w-[45%] shrink-0 lg:block">
        {/* Plain <img>: the Next optimizer has no Workers runtime, and this
            is a static asset — identical rendering via absolute fill. */}
        <img
          src="/onboarding-0.png"
          alt=""
          fetchPriority="high"
          loading="eager"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-black/45 via-black/20 to-transparent" />
      </div>

      <div className="flex flex-1 items-center justify-center px-8 py-16">
        <div className="flex w-full max-w-xl flex-col gap-8">
          <h1 className="type-display-md text-ink">
            Welcome to{" "}
            <KeyringMark className="mx-1 inline-block h-[0.9em] w-[0.9em] align-[-0.1em]" /> Keyring
          </h1>

          <div
            role="radiogroup"
            aria-label="Setup mode"
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
          >
            {MODES.map((opt) => {
              const selected = mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setMode(opt.value)}
                  className={
                    selected
                      ? "flex cursor-pointer flex-col gap-1 rounded-2xl border border-hairline bg-pillar p-4 transition-colors"
                      : "flex cursor-pointer flex-col gap-1 rounded-2xl border border-hairline bg-transparent p-4 transition-colors hover:bg-pillar/50"
                  }
                >
                  <span className="flex items-center gap-2">
                    <span className="flex h-4 w-4 items-center justify-center rounded-full border border-blue-600">
                      {selected && <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />}
                    </span>
                    <span
                      className={selected ? "type-body-sm text-ink" : "type-body-sm text-ink-muted"}
                    >
                      {opt.title}
                    </span>
                  </span>
                  <span className="type-body-sm text-ink-muted">{opt.description}</span>
                </button>
              );
            })}
          </div>

          {myRequest.data ? (
            <div className="flex flex-col gap-4 rounded-2xl border border-hairline bg-pillar p-6">
              <div>
                <div className="type-body-sm text-ink">
                  Request to join “{myRequest.data.organizations?.name ?? "workspace"}” pending
                </div>
                <p className="type-body-sm mt-1 text-ink-muted">
                  A workspace manager must approve your request. You can create your own workspace
                  meanwhile, or withdraw below.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void withdraw()}
                >
                  {saving ? "Withdrawing…" : "Withdraw request"}
                </Button>
              </div>
            </div>
          ) : null}

          {mode === "create" ? (
            subscription.isLoading ? (
              <div className="type-mono text-ink-muted">checking subscription…</div>
            ) : subscribed ? (
              <div className="w-full">
                <form onSubmit={create} id="onboarding-create-form">
                  <OrgSettingsFields draft={draft} setDraft={patch} />
                </form>
                <div className="mt-4 flex flex-row items-center gap-2">
                  <Button type="submit" form="onboarding-create-form" disabled={saving}>
                    {saving ? "Creating…" : "Create organization"}
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
                    onClick={() => void checkout.startCheckout("/onboarding")}
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
            )
          ) : (
            <form onSubmit={join} className="flex gap-2">
              <div className="flex-1 space-y-2">
                <Label className="sr-only">Organization slug</Label>
                <Input
                  value={joinSlug}
                  onChange={(e) => setJoinSlug(e.target.value)}
                  placeholder="acme"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button type="submit" disabled={saving}>
                  {saving ? "Requesting…" : "Request to join"}
                </Button>
              </div>
            </form>
          )}

          <button
            type="button"
            onClick={() => signOut()}
            className="type-body-sm w-fit cursor-pointer text-ink-muted hover:text-ink"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
