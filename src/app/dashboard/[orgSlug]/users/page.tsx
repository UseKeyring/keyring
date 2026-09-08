"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  isCustomerRole,
  logAction,
  useGrants,
  useMyAccess,
  useRoles,
  useSubjects,
  type Subject,
} from "@/hooks/useRbac";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NoAccess } from "@/components/ui/no-access";
import { TableSkeleton } from "@/components/ui/skeletons";
import { useMyOrganization } from "@/hooks/useOrganization";

export default function UsersPage() {
  const subjects = useSubjects();
  const roles = useRoles();
  const grants = useGrants();
  const { can, loading: accessLoading } = useMyAccess();
  const { user } = useAuth();
  const { orgId } = useMyOrganization();
  const qc = useQueryClient();
  const editable = can("users.manage");

  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["subjects"] });
    qc.invalidateQueries({ queryKey: ["grants"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!externalId.trim()) return;
    setSaving(true);
    const { error } = await getSupabaseBrowserClient().from("subjects").insert({
      external_id: externalId.trim(),
      display_name: displayName.trim() || null,
      organization_id: orgId,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "subject.created", externalId.trim());
    setExternalId("");
    setDisplayName("");
    refresh();
    toast.success("User added");
  };

  const remove = async (s: Subject) => {
    const { error } = await getSupabaseBrowserClient().from("subjects").delete().eq("id", s.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "subject.deleted", s.external_id);
    refresh();
    toast.success("User deleted");
  };

  const toggle = async (subject: Subject, roleId: string, on: boolean, roleSlug: string) => {
    const supabase = getSupabaseBrowserClient();
    if (on) {
      const { error } = await supabase
        .from("grants")
        .insert({ subject_id: subject.id, role_id: roleId });
      if (error) {
        toast.error(error.message);
        return;
      }
    } else {
      const { error } = await supabase
        .from("grants")
        .delete()
        .eq("subject_id", subject.id)
        .eq("role_id", roleId);
      if (error) {
        toast.error(error.message);
        return;
      }
    }
    if (user)
      await logAction(user.id, on ? "grant.added" : "grant.removed", `${subject.external_id}:${roleSlug}`);
    refresh();
  };

  const q = query.trim().toLowerCase();
  const customerRoles = (roles.data ?? []).filter(isCustomerRole);
  const loading = subjects.isLoading || roles.isLoading || grants.isLoading;
  const visible = (subjects.data ?? []).filter(
    (s) =>
      !q ||
      s.external_id.toLowerCase().includes(q) ||
      (s.display_name ?? "").toLowerCase().includes(q),
  );

  if (!accessLoading && !can("users.read")) {
    return <NoAccess title="Users" action="users.read" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Users</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            External end-users of your product, keyed by your own user IDs. They
            never sign into this console — access is checked per subject.
          </p>
        </div>
        <div className="relative w-full md:max-w-xs">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search users"
          />
        </div>
      </div>

      {editable && (
        <form
          onSubmit={create}
          className="grid gap-4 rounded-2xl border border-hairline bg-pillar p-6 md:grid-cols-3 md:p-8 dark:border-transparent dark:bg-polar-800"
        >
          <div className="space-y-2">
            <Label>External ID</Label>
            <Input
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              placeholder="user_123"
            />
          </div>
          <div className="space-y-2">
            <Label>Display name</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add user"}
            </Button>
          </div>
        </form>
      )}

      {loading ? (
        <TableSkeleton rows={6} columns={customerRoles.length + 2 || 3} />
      ) : (
      <div className="overflow-hidden rounded-2xl border border-hairline bg-canvas">
        <div className="overflow-x-auto">
          <table className="type-body-sm w-full min-w-[720px]">
            <thead>
              <tr className="type-mono border-b border-hairline text-left text-ink-muted">
                <th className="px-6 py-4 font-normal md:px-8">User</th>
                {customerRoles.map((r) => (
                  <th key={r.id} className="px-4 py-4 font-normal">
                    {r.name}
                  </th>
                ))}
                <th className="px-6 py-4 text-right font-normal md:px-8"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.id} className="border-b border-hairline last:border-0">
                  <td className="px-6 py-4 md:px-8">
                    <div className="type-mono text-ink">{s.external_id}</div>
                    <div className="type-caption text-ink-muted">
                      {s.display_name ?? "—"}
                    </div>
                  </td>
                  {(customerRoles).map((r) => {
                    const on = (grants.data ?? []).some(
                      (g) => g.subject_id === s.id && g.role_id === r.id,
                    );
                    return (
                      <td key={r.id} className="px-4 py-4">
                        <Checkbox
                          checked={on}
                          disabled={!editable}
                          onCheckedChange={(v) => toggle(s, r.id, Boolean(v), r.slug)}
                        />
                      </td>
                    );
                  })}
                  <td className="px-6 py-4 text-right md:px-8">
                    {editable ? (
                      <Button variant="destructive" size="sm" onClick={() => remove(s)}>
                        Delete
                      </Button>
                    ) : (
                      <span className="type-mono text-ink-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {!subjects.isLoading && visible.length === 0 && (
                <tr>
                  <td
                    className="px-6 py-6 text-ink-muted md:px-8"
                    colSpan={customerRoles.length + 2}
                  >
                    {q ? "No users match." : "No users yet — add your first subject above."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}
