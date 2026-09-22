"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  isCustomerRole,
  isGrantActive,
  logAction,
  useGrants,
  useMyAccess,
  useRoles,
  useSubjects,
  type Grant,
  type Role,
  type Subject,
} from "@/hooks/useRbac";
import { Button } from "@keyring/ui/components/button";
import { Checkbox } from "@keyring/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@keyring/ui/components/dialog";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { NoAccess } from "@keyring/ui/components/no-access";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@keyring/ui/components/select";
import { TableSkeleton } from "@keyring/ui/components/skeletons";
import { useMyOrganization } from "@/hooks/useOrganization";
import { AddUserDialog } from "./add-user-dialog";

const TEMP_PRESETS = [
  { value: "5m", label: "5 minutes", seconds: 5 * 60 },
  { value: "1h", label: "1 hour", seconds: 60 * 60 },
  { value: "24h", label: "24 hours", seconds: 24 * 60 * 60 },
  { value: "7d", label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { value: "custom", label: "Custom date…", seconds: 0 },
] as const;

function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "<1m left";
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

function TempAccessDialog({
  open,
  onOpenChange,
  subject,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: Subject | null;
  roles: Role[];
}) {
  const { user } = useAuth();
  const { orgId } = useMyOrganization();
  const qc = useQueryClient();
  const [roleId, setRoleId] = useState("");
  const [preset, setPreset] = useState<string>("5m");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject || !roleId || !orgId) return;
    const role = roles.find((r) => r.id === roleId);
    if (!role) return;

    let expiresAt: Date | null = null;
    if (preset === "custom") {
      if (!custom) {
        toast.error("Pick a custom expiry date");
        return;
      }
      expiresAt = new Date(custom);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        toast.error("Expiry must be in the future");
        return;
      }
      if (expiresAt.getTime() > Date.now() + 366 * 24 * 3600 * 1000) {
        toast.error("Expiry must be within 1 year");
        return;
      }
    } else {
      const found = TEMP_PRESETS.find((p) => p.value === preset);
      if (!found || found.seconds <= 0) return;
      expiresAt = new Date(Date.now() + found.seconds * 1000);
    }

    setSaving(true);
    const supabase = getSupabaseBrowserClient();
    const iso = expiresAt.toISOString();
    // Upsert: re-granting the same pair refreshes the expiry window.
    const { data: existing } = await supabase
      .from("grants")
      .select("id")
      .eq("subject_id", subject.id)
      .eq("role_id", roleId)
      .maybeSingle();
    const { error } = existing
      ? await supabase.from("grants").update({ expires_at: iso }).eq("id", (existing as { id: string }).id)
      : await supabase.from("grants").insert({
          subject_id: subject.id,
          role_id: roleId,
          organization_id: orgId,
          expires_at: iso,
        });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "grant.temp_added", `${subject.external_id}:${role.slug}`, iso);
    qc.invalidateQueries({ queryKey: ["grants"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
    toast.success(`Temporary access granted until ${expiresAt.toLocaleString()}`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl border border-hairline bg-white p-6 sm:max-w-md dark:border-polar-800 dark:bg-polar-950">
        <DialogTitle className="type-body-lg font-medium text-ink">Temporary access</DialogTitle>
        <DialogDescription className="type-body-sm text-ink-muted">
          {subject ? (
            <>
              Grant a role to <span className="type-mono text-ink">{subject.external_id}</span> for a
              bounded window. After it expires, <span className="type-mono">check()</span> denies
              automatically — no revoke call needed.
            </>
          ) : (
            "Grant a role for a bounded window."
          )}
        </DialogDescription>
        <form onSubmit={save} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} ({r.slug})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Duration</Label>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMP_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {preset === "custom" && (
            <div className="space-y-2">
              <Label>Expires at</Label>
              <Input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !roleId || (preset === "custom" && !custom)}>
              {saving ? "Granting…" : "Grant temporary access"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  const [tempSubject, setTempSubject] = useState<Subject | null>(null);
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

  /** Toggle a permanent grant. Turning ON over an expired row repairs it to permanent. */
  const toggle = async (subject: Subject, roleId: string, on: boolean, roleSlug: string) => {
    const supabase = getSupabaseBrowserClient();
    if (on) {
      if (!orgId) return;
      const { data: existing } = await supabase
        .from("grants")
        .select("id,expires_at")
        .eq("subject_id", subject.id)
        .eq("role_id", roleId)
        .maybeSingle();
      const row = existing as Pick<Grant, "id" | "expires_at"> | null;
      const { error } = row
        ? await supabase.from("grants").update({ expires_at: null }).eq("id", row.id)
        : await supabase
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

  const clearExpired = async () => {
    const supabase = getSupabaseBrowserClient();
    // Prefer the server-side purge (workspace-scoped, permission-checked);
    // fall back to a direct delete if the function is not deployed yet.
    const { error: rpcError } = await supabase.rpc("purge_expired_grants", { _hash: null });
    if (!rpcError) {
      if (user) await logAction(user.id, "grant.expired_purged", "");
      refresh();
      toast.success("Expired access cleared");
      return;
    }
    const { error } = await supabase
      .from("grants")
      .delete()
      .lte("expires_at", new Date().toISOString());
    if (error) {
      toast.error(error.message);
      return;
    }
    refresh();
    toast.success("Expired access cleared");
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
  const expiredCount = useMemo(
    () => (grants.data ?? []).filter((g) => !isGrantActive(g)).length,
    [grants.data],
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
            {expiredCount > 0 && (
              <span className="text-ink"> {expiredCount} expired grant{expiredCount === 1 ? "" : "s"} no longer authorize.</span>
            )}
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
          {editable && expiredCount > 0 && (
            <Button variant="secondary" onClick={clearExpired}>
              Clear expired ({expiredCount})
            </Button>
          )}
          {editable && <Button onClick={() => setAddOpen(true)}>Add user</Button>}
        </div>
      </div>

      {editable && <AddUserDialog open={addOpen} onOpenChange={setAddOpen} />}
      <TempAccessDialog
        open={tempSubject !== null}
        onOpenChange={(v) => {
          if (!v) setTempSubject(null);
        }}
        subject={tempSubject}
        roles={customerRoles}
      />

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
                    const grant = (grants.data ?? []).find(
                      (g) => g.subject_id === s.id && g.role_id === r.id,
                    );
                    const on = !!grant && isGrantActive(grant);
                    const expired = !!grant && !isGrantActive(grant);
                    return (
                      <td key={r.id} className="px-4 py-4">
                        <div className="flex flex-col gap-1">
                          <Checkbox
                            checked={on}
                            disabled={!editable}
                            title={
                              grant?.expires_at
                                ? expired
                                  ? `Expired at ${new Date(grant.expires_at).toLocaleString()} — check() denies`
                                  : `Temporary until ${new Date(grant.expires_at).toLocaleString()}`
                                : "Permanent grant"
                            }
                            onCheckedChange={(v) => toggle(s, r.id, Boolean(v), r.slug)}
                          />
                          {grant?.expires_at && (
                            <span
                              className={`type-mono text-[11px] ${expired ? "text-ink-subtle line-through" : "text-ink-muted"}`}
                            >
                              {expired ? "expired" : formatExpiry(grant.expires_at)}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-6 py-4 text-right md:px-8">
                    {editable ? (
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" size="sm" onClick={() => setTempSubject(s)}>
                          Temp access
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => remove(s)}>
                          Delete
                        </Button>
                      </div>
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
