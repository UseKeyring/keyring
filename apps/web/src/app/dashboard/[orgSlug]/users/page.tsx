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
import { Button } from "@keyring/ui/components/button";
import { Checkbox } from "@keyring/ui/components/checkbox";
import { Input } from "@keyring/ui/components/input";
import { NoAccess } from "@keyring/ui/components/no-access";
import { TableSkeleton } from "@keyring/ui/components/skeletons";
import { useMyOrganization } from "@/hooks/useOrganization";
import { AddUserDialog } from "./add-user-dialog";

export default function UsersPage() {
  const subjects = useSubjects();
  const roles = useRoles();
  const grants = useGrants();
  const { can, loading: accessLoading } = useMyAccess();
  const { user } = useAuth();
  const { orgId } = useMyOrganization();
  const qc = useQueryClient();
  const editable = can("users.manage");

  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["subjects"] });
    qc.invalidateQueries({ queryKey: ["grants"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
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
      if (!orgId) return;
      const { error } = await supabase
        .from("grants")
        .insert({ subject_id: subject.id, role_id: roleId, organization_id: orgId });
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
        <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto md:items-center">
          <div className="relative w-full md:w-auto md:min-w-[220px]">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search users"
            />
          </div>
          {editable && <Button onClick={() => setAddOpen(true)}>Add user</Button>}
        </div>
      </div>

      {editable && <AddUserDialog open={addOpen} onOpenChange={setAddOpen} />}

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
                    {q ? "No users match." : "No users yet — click Add user to create your first subject."}
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
