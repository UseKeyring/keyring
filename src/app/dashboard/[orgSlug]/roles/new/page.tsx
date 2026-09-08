"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAction, isCustomerPermission, useMyAccess, usePermissions, type Permission } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Section } from "@/components/ui/section";
import { useDashboardBase } from "../../../dashboard-chrome";

export default function NewRolePage() {
  const { can } = useMyAccess();
  const { user } = useAuth();
  const router = useRouter();
  const base = useDashboardBase();
  const perms = usePermissions();
  const { orgId } = useMyOrganization();
  const editable = can("roles.manage");

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const togglePerm = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug.trim() || !name.trim()) return;
    setSaving(true);
    const supabase = getSupabaseBrowserClient();
    const { data: role, error } = await supabase
      .from("roles")
      .insert({
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim() || null,
        scope: "customer",
        organization_id: orgId,
      })
      .select("id")
      .single();
    if (error || !role) {
      setSaving(false);
      toast.error(error?.message ?? "Could not create role");
      return;
    }
    if (selected.size > 0) {
      const { error: grantError } = await supabase.from("role_permissions").insert(
        [...selected].map((permission_id) => ({ role_id: role.id, permission_id })),
      );
      if (grantError) {
        setSaving(false);
        toast.error(grantError.message);
        return;
      }
    }
    setSaving(false);
    if (user) await logAction(user.id, "role.created", slug.trim());
    toast.success("Role created");
    router.push(`${base}/roles`);
    router.refresh();
  };

  const grouped = (perms.data ?? [])
    .filter(isCustomerPermission)
    .reduce<Record<string, Permission[]>>((acc, p) => {
      (acc[p.category] ||= []).push(p);
      return acc;
    }, {});

  if (!editable) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Create role</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            You need the roles.manage action to create roles.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Create role</h1>
        <p className="type-body-sm mt-1 text-ink-muted">
          Bundle actions into a named role. Select the permissions it should hold.
        </p>
      </div>

      <div className="flex flex-col rounded-4xl border border-hairline">
        <form id="new-role-form" onSubmit={create} className="flex flex-col divide-y divide-hairline">
          <Section title="Role" description="Basic role information">
            <div className="flex w-full flex-col gap-y-6">
              <div className="space-y-2">
                <Label>Slug</Label>
                <Input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="support"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Support agent"
                  required
                />
              </div>
            </div>
          </Section>

          <Section
            title="Details"
            description="How this role is described to your team"
          >
            <div className="flex w-full flex-col gap-y-6">
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

          <Section
            title="Actions"
            description="The permissions this role grants"
            cta={
              <span className="type-mono text-ink-muted">
                {selected.size} selected
              </span>
            }
          >
            <div className="flex w-full flex-col gap-y-8">
              {Object.entries(grouped).map(([cat, items]) => (
                <div key={cat}>
                  <div className="type-eyebrow pb-3 text-ink-muted">{cat}</div>
                  <div className="flex flex-col gap-y-3">
                    {(items ?? []).map((p) => (
                      <label key={p.id} className="flex cursor-pointer items-center gap-3">
                        <Checkbox
                          checked={selected.has(p.id)}
                          onCheckedChange={(v) => togglePerm(p.id, Boolean(v))}
                        />
                        <span className="type-body-sm text-ink">{p.slug}</span>
                        <span className="type-mono hidden text-ink-muted sm:inline">
                          {p.name}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {(perms.data ?? []).filter(isCustomerPermission).length === 0 && (
                <p className="type-body-sm text-ink-muted">
                  No actions exist yet — create some first.
                </p>
              )}
            </div>
          </Section>
        </form>
      </div>

      <div className="flex flex-row items-center gap-2 pb-12">
        <Button type="submit" form="new-role-form" disabled={saving}>
          {saving ? "Creating…" : "Create role"}
        </Button>
      </div>
    </div>
  );
}
