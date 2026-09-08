"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAction, useMemberRoles, useMyAccess, useProfiles, useRoles } from "@/hooks/useRbac";
import {
  useMyOrganization,
  useOrganizationMutations,
  usePendingJoinRequests,
} from "@/hooks/useOrganization";
import { Avatar } from "@/components/ui/profile-avatar";
import { NoAccess } from "@/components/ui/no-access";
import { TableSkeleton } from "@/components/ui/skeletons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function MembersPage() {
  const profiles = useProfiles();
  const roles = useRoles();
  const memberRoles = useMemberRoles();
  const { can, isOwner, loading: accessLoading } = useMyAccess();
  const { user } = useAuth();
  const { org, orgId } = useMyOrganization();
  const requests = usePendingJoinRequests(orgId);
  const { decideJoinRequest, removeMember } = useOrganizationMutations();
  const qc = useQueryClient();
  const editable = can("users.manage");
  const canDecide = isOwner || can("users.manage") || can("organizations.manage");
  const [deciding, setDeciding] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const consoleRoles = (roles.data ?? []).filter((r) => r.scope === "console");

  const refreshAccess = () => {
    qc.invalidateQueries({ queryKey: ["member_roles"] });
    qc.invalidateQueries({ queryKey: ["profiles"] });
    qc.invalidateQueries({ queryKey: ["organization-members"] });
    qc.invalidateQueries({ queryKey: ["join_requests"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
  };

  const remove = async (id: string, email: string, self: boolean) => {
    if (!orgId) return;
    setRemoving(id);
    try {
      await removeMember(id, orgId, email);
      refreshAccess();
      toast.success(self ? "Left workspace" : "Removed from workspace");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove member");
    } finally {
      setRemoving(null);
    }
  };

  const setConsoleRole = async (profileId: string, email: string, roleId: string) => {
    const supabase = getSupabaseBrowserClient();
    const current = (memberRoles.data ?? []).filter(
      (mr) => mr.profile_id === profileId && mr.organization_id === orgId,
    );
    const { error: delError } = current.length
      ? await supabase
          .from("member_roles")
          .delete()
          .eq("profile_id", profileId)
          .eq("organization_id", orgId ?? "")
      : { error: null };
    if (delError) {
      toast.error(delError.message);
      return;
    }
    if (roleId !== "none") {
      const { error } = await supabase
        .from("member_roles")
        .insert({ profile_id: profileId, role_id: roleId, organization_id: orgId });
      if (error) {
        toast.error(error.message);
        return;
      }
    }
    const role = consoleRoles.find((r) => r.id === roleId);
    if (user)
      await logAction(
        user.id,
        roleId === "none" ? "member.role_revoked" : "member.role_granted",
        `${email}:${role?.slug ?? "none"}`,
      );
    refreshAccess();
    toast.success(roleId === "none" ? "Console access revoked" : `Granted ${role?.name}`);
  };

  const team = (profiles.data ?? []).filter((p) => !orgId || p.organization_id === orgId);
  const loading =
    profiles.isLoading || roles.isLoading || memberRoles.isLoading || requests.isLoading;
  const consoleRoleIdFor = (profileId: string) =>
    (memberRoles.data ?? []).find(
      (mr) => mr.profile_id === profileId && mr.organization_id === orgId,
    )?.role_id ?? "none";

  const decide = async (id: string, approve: boolean, email: string) => {
    setDeciding(id);
    try {
      await decideJoinRequest(id, approve, email);
      refreshAccess();
      toast.success(approve ? "Request approved" : "Request rejected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not decide request");
    } finally {
      setDeciding(null);
    }
  };

  if (!accessLoading && !can("members.read")) {
    return <NoAccess title="Members" action="members.read" noun="list" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Members</h1>
        <p className="type-body-sm mt-1 text-ink-muted">
          The accounts operating this workspace. They manage the RBAC system but
          are never part of it — subjects live under Users.
        </p>
      </div>

      {loading ? (
        <TableSkeleton rows={5} columns={3} avatar />
      ) : (
      <>
      {canDecide && (requests.data ?? []).length > 0 && (
      <div className="overflow-hidden rounded-2xl border border-hairline bg-canvas">
        <div className="type-mono px-6 pt-4 text-ink-muted md:px-8">
          Pending requests ({requests.data?.length})
        </div>
        <div className="overflow-x-auto">
          <table className="type-body-sm w-full min-w-[480px]">
            <tbody>
              {(requests.data ?? []).map((r) => (
                <tr key={r.id} className="border-b border-hairline last:border-0">
                  <td className="px-6 py-4 md:px-8">
                    <div className="flex items-center gap-3">
                      <Avatar
                        name={r.profiles?.full_name || r.profiles?.email || "?"}
                        avatar_url={r.profiles?.avatar_url ?? null}
                        className="h-8 w-8"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-ink">
                          {r.profiles?.full_name ? `${r.profiles.full_name} · ` : ""}
                          {r.profiles?.email ?? "—"}
                        </div>
                        <div className="type-mono text-ink-muted">
                          requested {new Date(r.created_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right md:px-8">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={deciding === r.id}
                        onClick={() => void decide(r.id, false, r.profiles?.email ?? r.id)}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        disabled={deciding === r.id}
                        onClick={() => void decide(r.id, true, r.profiles?.email ?? r.id)}
                      >
                        {deciding === r.id ? "Saving…" : "Approve"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}
      <div className="overflow-hidden rounded-2xl border border-hairline bg-canvas">
        <div className="overflow-x-auto">
          <table className="type-body-sm w-full min-w-[480px]">
            <thead>
              <tr className="type-mono border-b border-hairline text-left text-ink-muted">
                <th className="px-6 py-4 font-normal md:px-8">Member</th>
                <th className="px-6 py-4 font-normal md:px-8">Console role</th>
                <th className="px-6 py-4 font-normal md:px-8">Joined</th>
                <th className="px-6 py-4 text-right font-normal md:px-8"></th>
              </tr>
            </thead>
            <tbody>
              {team.map((p) => {
                const isOwner = org.data?.created_by === p.id;
                const isSelf = p.id === user?.id;
                return (
                  <tr key={p.id} className="border-b border-hairline last:border-0">
                    <td className="px-6 py-4 md:px-8">
                      <div className="flex items-center gap-3">
                        <Avatar
                          name={p.full_name || p.email}
                          avatar_url={p.avatar_url ?? null}
                          className="h-8 w-8"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-ink">
                            {p.full_name ? `${p.full_name} · ` : ""}
                            {p.email}
                          </div>
                          <div className="type-mono text-ink-muted">
                            {isOwner ? "owner" : "member"}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 md:px-8">
                      {editable && !isOwner ? (
                        <Select
                          value={consoleRoleIdFor(p.id)}
                          onValueChange={(v) => void setConsoleRole(p.id, p.email, v)}
                        >
                          <SelectTrigger className="w-[160px] rounded-full">
                            <SelectValue placeholder="No access" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No access</SelectItem>
                            {consoleRoles.map((r) => (
                              <SelectItem key={r.id} value={r.id}>
                                {r.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="type-mono text-ink-muted">
                          {isOwner ? "full access" : "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right md:px-8">
                      {isSelf && !isOwner ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={removing === p.id}
                          onClick={() => void remove(p.id, p.email, true)}
                        >
                          {removing === p.id ? "Leaving…" : "Leave"}
                        </Button>
                      ) : editable && !isOwner ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={removing === p.id}
                          onClick={() => void remove(p.id, p.email, false)}
                        >
                          {removing === p.id ? "Removing…" : "Remove"}
                        </Button>
                      ) : (
                        <span className="type-mono text-ink-subtle">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!profiles.isLoading && team.length === 0 && (
                <tr>
                  <td className="px-6 py-6 text-ink-muted md:px-8" colSpan={3}>
                    No members yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
