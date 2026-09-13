"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { logAction, useMyAccess } from "@/hooks/useRbac";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import {
  slugify,
  useMyOrganization,
  useOrganizationMutations,
} from "@/hooks/useOrganization";
import { Button } from "@/components/ui/button";
import { CopyToClipboardInput } from "@/components/ui/copy-to-clipboard-input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  SettingsGroup,
  SettingsGroupItem,
} from "@/components/ui/settings-group";
import {
  EMPTY_DRAFT,
  OrgSettingsFields,
  orgDraftFromOrg,
  type OrgDraft,
} from "./org-fields";
import { ApiKeysSection } from "./api-keys";
import { BackupsSection } from "./backups";
import { SettingsSkeleton } from "@/components/ui/skeletons";



function EditOrganization() {
  const { org } = useMyOrganization();
  const { user } = useAuth();
  const { can } = useMyAccess();
  const { updateOrganization } = useOrganizationMutations();
  const current = org.data;

  const [draft, setDraft] = useState<OrgDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const d = draft ?? (current ? orgDraftFromOrg(current) : EMPTY_DRAFT);
  const patch = (p: Partial<OrgDraft>) =>
    setDraft((prev) => ({ ...(prev ?? (current ? orgDraftFromOrg(current) : EMPTY_DRAFT)), ...p }));

  if (!current) return null;
  const canEdit = current.created_by === user?.id || can("organizations.manage");

  const normalized = {
    name: d.name.trim(),
    slug: slugify(d.slug),
    avatarUrl: d.avatarUrl.trim(),
    website: d.website.trim(),
    supportEmail: d.supportEmail.trim(),
  };
  const pristine = {
    name: current.name,
    slug: current.slug,
    avatarUrl: current.avatar_url ?? "",
    website: current.website ?? "",
    supportEmail: current.support_email ?? "",
  };
  const dirty = JSON.stringify(normalized) !== JSON.stringify(pristine);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!d.name.trim() || !d.slug.trim()) {
      toast.error("Name and slug are required");
      return;
    }
    setSaving(true);
    try {
      await updateOrganization(current.id, {
        name: d.name.trim(),
        slug: slugify(d.slug),
        avatar_url: d.avatarUrl.trim() || null,
        website: d.website.trim() || null,
        support_email: d.supportEmail.trim() || null,
      });
      toast.success("Organization saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save organization");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsGroup>
        <SettingsGroupItem
          title="Identifier"
          description="Unique identifier for your organization"
        >
          <CopyToClipboardInput value={current.id} variant="mono" ariaLabel="Organization identifier" />
        </SettingsGroupItem>
        <SettingsGroupItem
          title="Organization Slug"
          description="Used for Customer Portal, Transaction Statements, etc."
        >
          <CopyToClipboardInput value={current.slug} variant="mono" ariaLabel="Organization slug" />
        </SettingsGroupItem>
      </SettingsGroup>
      <form onSubmit={submit} id="edit-organization-form">
        <OrgSettingsFields draft={d} setDraft={patch} disabled={!canEdit} />
      </form>
      {!canEdit && (
        <p className="type-mono text-ink-muted">
          Only the creator or organization managers can edit this.
        </p>
      )}
      {canEdit && dirty && (
        <div className="flex flex-row items-center gap-2">
          <Button type="submit" form="edit-organization-form" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </>
  );
}

function DangerZone() {
  const { org } = useMyOrganization();
  const { user } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const current = org.data;

  if (!current || current.created_by !== user?.id) return null;

  const destroy = async () => {
    if (confirm.trim() !== current.slug) return;
    setDeleting(true);
    try {
      const supabase = getSupabaseBrowserClient();
      if (user) await logAction(user.id, "organization.deleted", current.slug);
      const { error } = await supabase.from("organizations").delete().eq("id", current.id);
      if (error) throw error;
      toast.success("Workspace deleted");
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["organization"] });
      qc.invalidateQueries({ queryKey: ["organization-members"] });
      setOpen(false);
      router.replace("/onboarding");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete workspace");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <SettingsGroup>
        <SettingsGroupItem
          title="Delete Workspace"
          description="Permanently delete this workspace and all associated data. This action cannot be undone."
        >
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              setConfirm("");
              setOpen(true);
            }}
          >
            Delete
          </Button>
        </SettingsGroupItem>
      </SettingsGroup>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-2xl border border-hairline bg-white p-8 sm:max-w-[600px] dark:border-polar-800 dark:bg-polar-950">
          <DialogTitle className="text-xl font-medium text-ink">
            Delete Workspace
          </DialogTitle>
          <p className="type-body-sm mt-2 text-ink-muted">
            Are you sure you want to delete “{current.name}”? This action cannot be undone.
          </p>
          <div className="type-body-sm mt-4 text-ink-muted">
            <p className="mb-2">When you delete a workspace:</p>
            <ul className="list-inside list-disc space-y-1">
              <li>Every member is unlinked from the workspace</li>
              <li>Roles, actions, users and grants stay intact</li>
              <li>You will be taken back to onboarding</li>
            </ul>
          </div>
          <p className="type-body-sm mt-4 text-ink-muted">
            Please enter “{current.slug}” to confirm:
          </p>
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={current.slug}
            className="mt-2"
          />
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting || confirm.trim() !== current.slug}
              onClick={() => void destroy()}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function SettingsPage() {
  const { org, orgId, profile } = useMyOrganization();
  const loading = profile.isLoading || (!!orgId && org.isLoading);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Workspace settings</h1>
        <p className="type-body-sm mt-1 text-ink-muted">
          Workspace identity, API keys and danger zone. Your personal account lives
          under account settings.
        </p>
      </div>

      {loading ? (
        <>
          <SettingsSkeleton />
          <SettingsSkeleton />
          <SettingsSkeleton />
        </>
      ) : org.data ? (
        <>
          <EditOrganization key={org.data.id} />
          <ApiKeysSection />
          <BackupsSection />
          <DangerZone />
        </>
      ) : null}
    </div>
  );
}
