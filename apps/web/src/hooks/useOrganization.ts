"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAction } from "@/hooks/useRbac";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  avatar_url: string | null;
  website: string | null;
  support_email: string | null;
  created_by: string | null;
  created_at: string;
  telemetry_enabled: boolean;
  telemetry_subject_mode: string;
};

export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function useMyProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("profiles")
        .select("*")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as {
        id: string;
        email: string;
        full_name: string | null;
        avatar_url: string | null;
        organization_id: string | null;
        created_at: string;
      } | null;
    },
  });
}

export function useMyOrganization() {
  const profile = useMyProfile();
  const orgId = profile.data?.organization_id ?? null;
  const org = useQuery({
    queryKey: ["organization", orgId],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<Organization> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("organizations")
        .select("*")
        .eq("id", orgId!)
        .single();
      if (error) throw error;
      return data as Organization;
    },
  });
  return { profile, orgId, org };
}

export function useOrganizationMembers(orgId: string | null) {
  return useQuery({
    queryKey: ["organization-members", orgId],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("profiles")
        .select("*")
        .eq("organization_id", orgId!)
        .order("created_at");
      if (error) throw error;
      return data as {
        id: string;
        email: string;
        full_name: string | null;
        avatar_url: string | null;
        organization_id: string | null;
        created_at: string;
      }[];
    },
  });
}

export type JoinRequest = {
  id: string;
  organization_id: string;
  profile_id: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export type JoinRequester = {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
};

/** The caller's own pending join request, if any (with the target org). */
export function useMyJoinRequest() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["my_join_request", user?.id],
    enabled: !!user,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("organization_join_requests")
        .select("*, organizations (id, name, slug)")
        .eq("profile_id", user!.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as
        (JoinRequest & { organizations: Pick<Organization, "id" | "name" | "slug"> | null }) | null;
    },
  });
}

/** Pending join requests for an org (managers only — enforced by RLS). */
export function usePendingJoinRequests(orgId: string | null) {
  return useQuery({
    queryKey: ["join_requests", orgId],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("organization_join_requests")
        .select("*, profiles (id, email, full_name, avatar_url)")
        .eq("organization_id", orgId!)
        .eq("status", "pending")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as (JoinRequest & { profiles: JoinRequester | null })[];
    },
  });
}

export type WorkspaceMembership = {
  organization_id: string;
  created_at: string;
  organizations: Pick<Organization, "id" | "name" | "slug" | "avatar_url"> | null;
};

/** All workspaces the caller belongs to (drives the switcher + URL gate). */
export function useMyWorkspaces() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["my_workspaces", user?.id],
    enabled: !!user,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("organization_members")
        .select("organization_id, created_at, organizations (id, name, slug, avatar_url)")
        .eq("profile_id", user!.id)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as WorkspaceMembership[];
    },
  });
}

export function useOrganizationMutations() {
  const qc = useQueryClient();
  const { user } = useAuth();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["profile"] });
    qc.invalidateQueries({ queryKey: ["organization"] });
    qc.invalidateQueries({ queryKey: ["organization-members"] });
    qc.invalidateQueries({ queryKey: ["my_workspaces"] });
    qc.invalidateQueries({ queryKey: ["my_console_permissions"] });
    qc.invalidateQueries({ queryKey: ["roles"] });
    qc.invalidateQueries({ queryKey: ["permissions"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
  };

  // Workspace changed (switch / approve / remove): queries keyed without the
  // workspace would go stale, so drop the whole cache. This refetches
  // billing/subscription rows too — acceptable one-time cost on a switch.
  const refreshAll = () => {
    qc.invalidateQueries();
  };

  // Link the account to an organization. Uses upsert so fresh signups whose
  // profile row hasn't landed yet still end up linked.
  const linkProfile = async (organization_id: string) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await getSupabaseBrowserClient()
      .from("profiles")
      .upsert({ id: user.id, email: user.email ?? "", organization_id }, { onConflict: "id" });
    if (error) throw error;
  };

  const createOrganization = async (input: {
    name: string;
    slug: string;
    avatar_url?: string | null;
    website?: string | null;
    support_email?: string | null;
  }) => {
    if (!user) throw new Error("Not signed in");
    if (input.slug.trim().toLowerCase() === "account" || input.slug.trim().toLowerCase() === "new") {
      throw new Error(`Slug "${input.slug.trim().toLowerCase()}" is reserved — pick another one.`);
    }
    const supabase = getSupabaseBrowserClient();
    // Friendly pre-check; RLS ("subscribed create organizations" in 0010)
    // enforces the same rule against direct API calls, so a denied insert
    // below is still fail-closed even if this read fails.
    const { data: sub, error: subError } = await supabase
      .from("user_subscriptions")
      .select("plan,status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (subError) {
      throw new Error(
        "Could not verify your subscription — please retry. If this persists, check billing before creating a workspace.",
      );
    }
    const row = sub as { plan: string; status: string } | null;
    if (!row || !(row.plan === "pro" || row.plan === "enterprise") || row.status !== "active") {
      throw new Error("Creating a workspace requires an active Pro or Enterprise subscription.");
    }
    const { data: org, error } = await supabase
      .from("organizations")
      .insert({
        name: input.name.trim(),
        slug: input.slug.trim(),
        avatar_url: input.avatar_url?.trim() || null,
        website: input.website?.trim() || null,
        support_email: input.support_email?.trim() || null,
        created_by: user.id,
      })
      .select("*")
      .single();
    if (error || !org) throw error ?? new Error("Could not create organization");
    await linkProfile((org as Organization).id);
    await logAction(
      user.id,
      "organization.created",
      (org as Organization).slug,
      undefined,
      (org as Organization).id,
    );
    refresh();
    return org as Organization;
  };

  const updateOrganization = async (
    id: string,
    patch: Partial<
      Pick<Organization, "name" | "slug" | "avatar_url" | "website" | "support_email">
    >,
  ) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await getSupabaseBrowserClient()
      .from("organizations")
      .update(patch)
      .eq("id", id);
    if (error) throw error;
    await logAction(user.id, "organization.updated", patch.slug ?? id, undefined, id);
    refresh();
  };

  const refreshJoinRequests = () => {
    qc.invalidateQueries({ queryKey: ["my_join_request"] });
    qc.invalidateQueries({ queryKey: ["join_requests"] });
    refresh();
  };

  // Request membership by slug. Approval links the profile — nobody can
  // self-link anymore (see the org-link guard trigger in 0009).
  const requestJoinOrganization = async (slug: string) => {
    if (!user) throw new Error("Not signed in");
    const { data, error } = await getSupabaseBrowserClient().rpc("request_to_join_org", {
      _slug: slug.trim().toLowerCase(),
    });
    if (error) throw error;
    await logAction(user.id, "organization.join_requested", slug.trim().toLowerCase());
    refreshJoinRequests();
    return data as string;
  };

  const withdrawJoinRequest = async (id: string) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await getSupabaseBrowserClient()
      .from("organization_join_requests")
      .delete()
      .eq("id", id);
    if (error) throw error;
    refreshJoinRequests();
  };

  // Approve or reject a pending request. Approval adds the membership edge
  // and activates the workspace; only managers of that org may call it.
  const decideJoinRequest = async (id: string, approve: boolean, target?: string) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await getSupabaseBrowserClient().rpc("decide_join_request", {
      _request_id: id,
      _approve: approve,
    });
    if (error) throw error;
    await logAction(
      user.id,
      approve ? "organization.join_approved" : "organization.join_rejected",
      target ?? id,
    );
    refreshJoinRequests();
    refreshAll();
  };

  // Activate one of my workspaces (follows the URL slug).
  const switchOrganization = async (organizationId: string) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await getSupabaseBrowserClient().rpc("switch_organization", {
      _organization_id: organizationId,
    });
    if (error) throw error;
    refreshAll();
  };

  // Manager-or-self removal from a workspace. Revokes that workspace's
  // console grants and repairs the active workspace server-side.
  const removeMember = async (profileId: string, organizationId: string, email: string) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await getSupabaseBrowserClient().rpc("remove_member", {
      _profile_id: profileId,
      _organization_id: organizationId,
    });
    if (error) throw error;
    // Audit in the TARGET workspace, not the actor's active one (they may
    // differ when managing from another workspace).
    await logAction(user.id, "member.removed", email, undefined, organizationId);
    refreshAll();
  };

  return {
    createOrganization,
    updateOrganization,
    requestJoinOrganization,
    withdrawJoinRequest,
    decideJoinRequest,
    switchOrganization,
    removeMember,
  };
}
