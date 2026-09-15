"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAction, useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { Button } from "@keyring/ui/components/button";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { Section } from "@keyring/ui/components/section";
import { useDashboardBase } from "../../../dashboard-chrome";

export default function NewActionPage() {
  const { can } = useMyAccess();
  const { user } = useAuth();
  const router = useRouter();
  const base = useDashboardBase();
  const { orgId } = useMyOrganization();
  const editable = can("permissions.manage");

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug.trim() || !name.trim()) return;
    setSaving(true);
    const { error } = await getSupabaseBrowserClient().from("permissions").insert({
      slug: slug.trim(),
      name: name.trim(),
      category: category.trim() || "General",
      description: description.trim() || null,
      scope: "customer",
      organization_id: orgId,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "action.created", slug.trim());
    toast.success("Action created");
    router.push(`${base}/actions`);
    router.refresh();
  };

  if (!editable) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Create action</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            You need the permissions.manage action to create actions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Create action</h1>
        <p className="type-body-sm mt-1 text-ink-muted">
          Define one atomic thing a user can do. Roles are built out of these.
        </p>
      </div>

      <div className="flex flex-col rounded-4xl border border-hairline">
        <form id="new-action-form" onSubmit={create} className="flex flex-col divide-y divide-hairline">
          <Section title="Action" description="Basic action information">
            <div className="flex w-full flex-col gap-y-6">
              <div className="space-y-2">
                <Label>Slug</Label>
                <Input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="invoices.refund"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Refund invoices"
                  required
                />
              </div>
            </div>
          </Section>

          <Section
            title="Details"
            description="How this action is grouped and described"
          >
            <div className="flex w-full flex-col gap-y-6">
              <div className="space-y-2">
                <Label>Category</Label>
                <Input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Billing"
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </Section>
        </form>
      </div>

      <div className="flex flex-row items-center gap-2 pb-12">
        <Button type="submit" form="new-action-form" disabled={saving}>
          {saving ? "Creating…" : "Create action"}
        </Button>
      </div>
    </div>
  );
}
