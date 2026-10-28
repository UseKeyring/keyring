"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  isCustomerRole,
  logAction,
  useMyAccess,
  useRoles,
  useSpaces,
  type Space,
} from "@/hooks/useRbac";
import { Button } from "@keyring/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@keyring/ui/components/dialog";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { NoAccess } from "@keyring/ui/components/no-access";
import { useMyOrganization } from "@/hooks/useOrganization";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@keyring/ui/components/select";
import { CardsSkeleton } from "@keyring/ui/components/skeletons";
import { SolarIcon } from "@keyring/ui/components/solar-icon";

function NewSpaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const { orgId } = useMyOrganization();
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug.trim() || !name.trim() || !orgId) return;
    setSaving(true);
    const { error } = await getSupabaseBrowserClient().from("spaces").insert({
      slug: slug.trim().toLowerCase(),
      name: name.trim(),
      organization_id: orgId,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "space.created", slug.trim().toLowerCase());
    qc.invalidateQueries({ queryKey: ["spaces"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
    toast.success("Space created");
    setSlug("");
    setName("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl border border-hairline bg-white p-6 sm:max-w-md dark:border-polar-800 dark:bg-polar-950">
        <DialogTitle className="type-body-lg font-medium text-ink">New space</DialogTitle>
        <DialogDescription className="type-body-sm text-ink-muted">
          A fully isolated scope: its own actions, roles and grants. Platform-level
          access never leaks into a space.
        </DialogDescription>
        <form onSubmit={create} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label>Slug</Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="acme"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !slug.trim() || !name.trim()}>
              {saving ? "Creating…" : "Create space"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SpaceCard({ space }: { space: Space }) {
  const { user } = useAuth();
  const { can } = useMyAccess();
  const roles = useRoles();
  const qc = useQueryClient();
  const editable = can("roles.manage") || can("users.manage");

  const spaceRoles = (roles.data ?? []).filter(
    (r) => isCustomerRole(r) && r.space_id === space.id,
  );

  const remove = async () => {
    const { error } = await getSupabaseBrowserClient().from("spaces").delete().eq("id", space.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "space.deleted", space.slug);
    qc.invalidateQueries({ queryKey: ["spaces"] });
    qc.invalidateQueries({ queryKey: ["roles"] });
    qc.invalidateQueries({ queryKey: ["grants"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
    toast.success("Space deleted — its roles, actions and grants went with it");
  };

  const setDefaultRole = async (roleId: string | null) => {
    const { error } = await getSupabaseBrowserClient()
      .from("spaces")
      .update({ default_role_id: roleId })
      .eq("id", space.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "space.default_role_set", space.slug);
    qc.invalidateQueries({ queryKey: ["spaces"] });
    toast.success("Default role updated");
  };

  return (
    <div className="rounded-2xl border border-hairline bg-pillar p-6 md:p-8 dark:border-transparent dark:bg-polar-800">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="type-body-lg font-medium text-ink">{space.name}</h2>
          <div className="type-mono text-ink-muted">{space.slug}</div>
          {space.description && (
            <p className="type-body-sm mt-2 text-ink-muted">{space.description}</p>
          )}
          <p className="type-mono mt-2 text-ink-muted">
            {spaceRoles.length} role{spaceRoles.length === 1 ? "" : "s"}
          </p>
        </div>
        {editable && (
          <Button
            variant="destructive"
            size="sm"
            onClick={remove}
            title="Deletes the space and everything in it"
          >
            Delete
          </Button>
        )}
      </div>

      <div className="mt-6 space-y-2 border-t border-hairline pt-6">
        <Label>Default role (provisioning)</Label>
        <Select
          value={space.default_role_id ?? "none"}
          onValueChange={(v) => setDefaultRole(v === "none" ? null : v)}
          disabled={!editable}
        >
          <SelectTrigger>
            <SelectValue placeholder="No default — provisioning fails closed" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None (fail closed)</SelectItem>
            {spaceRoles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name} ({r.slug})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="type-caption text-ink-muted">
          New signups provisioned with this space land here. Changing it affects future
          signups only.
        </p>
      </div>
    </div>
  );
}

export default function SpacesPage() {
  const spaces = useSpaces();
  const { can, loading: accessLoading } = useMyAccess();
  const [createOpen, setCreateOpen] = useState(false);
  const editable = can("roles.manage") || can("users.manage");

  if (!accessLoading && !can("roles.read")) {
    return <NoAccess title="Spaces" action="roles.read" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Spaces</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            Isolated scopes inside this workspace — each space has its own actions,
            roles and grants. A user can hold different access in each space.
          </p>
        </div>
        {editable && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <SolarIcon name="plus" className="h-3.5 w-3.5" />
            <span className="hidden md:inline">New Space</span>
          </Button>
        )}
      </div>

      <NewSpaceDialog open={createOpen} onOpenChange={setCreateOpen} />

      {spaces.isLoading ? (
        <CardsSkeleton />
      ) : (spaces.data ?? []).length === 0 ? (
        <div className="type-body-sm rounded-2xl border border-hairline bg-pillar p-8 text-center text-ink-muted">
          No spaces yet — everything lives in the platform scope. Create a space to
          isolate a tenant&apos;s actions, roles and grants.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(spaces.data ?? []).map((s) => (
            <SpaceCard key={s.id} space={s} />
          ))}
        </div>
      )}
    </div>
  );
}
