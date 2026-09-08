"use client";

import { useQuery } from "@tanstack/react-query";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMyOrganization, useMyProfile } from "@/hooks/useOrganization";

export type Role = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  is_system: boolean;
  scope: string;
  created_at: string;
};

export type Permission = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  is_system: boolean;
  scope: string;
  created_at: string;
};

export type RolePermission = { id: string; role_id: string; permission_id: string };
export type Grant = { id: string; role_id: string; subject_id: string };
export type MemberRole = {
  id: string;
  profile_id: string;
  role_id: string;
  organization_id: string | null;
};
export type Subject = {
  id: string;
  external_id: string;
  display_name: string | null;
  created_at: string;
};
export type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  organization_id: string | null;
  created_at: string;
};

export function useRoles() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["roles", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<Role[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("roles")
        .select("*")
        .order("created_at");
      if (error) throw error;
      return data as Role[];
    },
  });
}

export function usePermissions() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["permissions", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<Permission[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("permissions")
        .select("*")
        .order("category");
      if (error) throw error;
      return data as Permission[];
    },
  });
}

export function useRolePermissions() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["role_permissions", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<RolePermission[]> => {
      const { data, error } = await getSupabaseBrowserClient().from("role_permissions").select("*");
      if (error) throw error;
      return data as RolePermission[];
    },
  });
}

export function useGrants() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["grants", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<Grant[]> => {
      const { data, error } = await getSupabaseBrowserClient().from("grants").select("*");
      if (error) throw error;
      return data as Grant[];
    },
  });
}

export function useMemberRoles() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["member_roles", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<MemberRole[]> => {
      const { data, error } = await getSupabaseBrowserClient().from("member_roles").select("*");
      if (error) throw error;
      return data as MemberRole[];
    },
  });
}

/** Customer-plane helpers: console surfaces must never render scope='console' rows. */
export const isCustomerRole = (r: Role) => r.scope !== "console";
export const isCustomerPermission = (p: Permission) => p.scope !== "console";

export function useSubjects() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["subjects", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<Subject[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("subjects")
        .select("*")
        .order("created_at");
      if (error) throw error;
      return data as Subject[];
    },
  });
}

export function useProfiles() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["profiles", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<Profile[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("profiles")
        .select("*")
        .order("created_at");
      if (error) throw error;
      return data as Profile[];
    },
  });
}

export function useAuditLog() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["audit_log", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("audit_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as {
        id: string;
        actor_id: string | null;
        action: string;
        target: string | null;
        detail: string | null;
        created_at: string;
      }[];
    },
  });
}

// Manage permission → the read permission(s) it implies.
// Mirrors the server policies in 0009/0011, which check `read OR manage`
// for every readable surface. The generic `.manage` → `.read` rule covers
// roles/permissions (and any future pair); `members.read` has no
// `members.manage` counterpart and is granted via `users.manage`.
const READ_IMPLIED_BY: Record<string, string[]> = {
  "roles.read": ["roles.manage"],
  "permissions.read": ["permissions.manage"],
  "users.read": ["users.manage"],
  "members.read": ["users.manage"],
};

function impliedHolders(slug: string, mine: Set<string>): boolean {
  if ((READ_IMPLIED_BY[slug] ?? []).some((s) => mine.has(s))) return true;
  // Generic fallback: `<base>.manage` implies `<base>.read` for any future pair.
  if (slug.endsWith(".read")) {
    const base = slug.slice(0, -".read".length);
    if (mine.has(`${base}.manage`)) return true;
  }
  return false;
}

/**
 * Console access (hidden plane). Console accounts operate the workspace and
 * are never part of the customer RBAC graph. Access derives from console
 * roles held via member_roles; organization creators implicitly hold all.
 *
 * Slugs come from the my_console_permissions() SECURITY DEFINER function —
 * the RBAC tables themselves are read-gated, so access cannot be computed
 * from client-side table reads (that would deadlock discovery of read
 * permissions). Manage permissions imply their read counterpart.
 */
export function useMyAccess() {
  const { user } = useAuth();
  const profile = useMyProfile();
  const { org, orgId } = useMyOrganization();

  const permsQuery = useQuery({
    queryKey: ["my_console_permissions", user?.id, orgId ?? null],
    // my_console_permissions() derives the workspace from
    // profiles.organization_id server-side (ambient state). Don't fire
    // until the target workspace is known or the RPC can run against the
    // previous workspace and get cached under the new key.
    enabled: !!user && !!orgId,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await getSupabaseBrowserClient().rpc("my_console_permissions");
      if (error) throw error;
      return (data ?? []) as string[];
    },
  });

  const isOwner = !!user && org.data?.created_by === user.id;
  const mySlugs = new Set(permsQuery.data ?? []);

  return {
    isOwner,
    can: (slug: string) => isOwner || mySlugs.has(slug) || impliedHolders(slug, mySlugs),
    loading: profile.isLoading || permsQuery.isLoading || org.isLoading,
  };
}

export async function logAction(
  actorId: string,
  action: string,
  target?: string,
  detail?: string,
  organizationId?: string | null,
) {
  const { error } = await getSupabaseBrowserClient()
    .from("audit_log")
    .insert({
      actor_id: actorId,
      action,
      target: target ?? null,
      detail: detail ?? null,
      ...(organizationId ? { organization_id: organizationId } : {}),
    });
  if (error) {
    // Audit must never break the caller flow (fresh signups may have no
    // active workspace yet, so the fill_audit_org trigger leaves NULL and
    // the NOT NULL insert fails). Warn and continue.
    console.warn("[audit] insert failed:", error.code ?? "unknown", error.message);
    if (process.env["NODE_ENV"] !== "production") {
      console.warn("[audit] context:", { actorId, action, target, organizationId });
    }
  }
}
