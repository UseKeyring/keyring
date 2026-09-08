"use client";

import { useState } from "react";
import { slugify } from "@/hooks/useOrganization";
import { AvatarUpload } from "@/components/ui/avatar-upload";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsGroup, SettingsGroupItem } from "@/components/ui/settings-group";

export type OrgDraft = {
  name: string;
  slug: string;
  avatarUrl: string;
  website: string;
  supportEmail: string;
};

export const EMPTY_DRAFT: OrgDraft = {
  name: "",
  slug: "",
  avatarUrl: "",
  website: "",
  supportEmail: "",
};

export function orgDraftFromOrg(org: {
  name: string;
  slug: string;
  avatar_url: string | null;
  website: string | null;
  support_email: string | null;
}): OrgDraft {
  return {
    name: org.name,
    slug: org.slug,
    avatarUrl: org.avatar_url ?? "",
    website: org.website ?? "",
    supportEmail: org.support_email ?? "",
  };
}

/*
 * Organization profile form (Polar details pattern): logo tile + name share
 * one row, then split rows for the rest. Shared by Settings and Onboarding.
 */
export function OrgSettingsFields({
  draft,
  setDraft,
  disabled,
}: {
  draft: OrgDraft;
  setDraft: (patch: Partial<OrgDraft>) => void;
  disabled?: boolean;
}) {
  // Slug live-syncs from the name until it's manually edited. Pre-filled
  // slugs (edit mode) start out as touched so typing a name never clobbers them.
  const [slugTouched, setSlugTouched] = useState(() => draft.slug.length > 0);

  const onNameChange = (next: string) => {
    setDraft({ name: next });
    if (!slugTouched) setDraft({ slug: slugify(next) });
  };

  const onSlugChange = (next: string) => {
    setSlugTouched(true);
    setDraft({ slug: slugify(next) });
  };

  const body = (
    <>
      <div className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-[auto_1fr] sm:gap-x-5">
        <div>
          <Label className="mb-2 block">Logo</Label>
          <AvatarUpload
            name={draft.name}
            value={draft.avatarUrl}
            onChange={(avatarUrl) => setDraft({ avatarUrl })}
            disabled={disabled}
            storagePrefix="org-logos"
            noun="Logo"
          />
        </div>
        <div>
          <Label className="mb-2 block">
            Organization Name <span aria-hidden>*</span>
          </Label>
          <Input
            value={draft.name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Rexa DB"
            disabled={disabled}
            required
          />
        </div>
      </div>

      <SettingsGroupItem
        title="Organization Slug"
        description="Used to join this workspace"
      >
        <div className="space-y-2">
          <Label className="sr-only">Slug</Label>
          <Input
            value={draft.slug}
            onChange={(e) => onSlugChange(e.target.value)}
            placeholder="acme"
            disabled={disabled}
          />
        </div>
      </SettingsGroupItem>

      <SettingsGroupItem title="Website">
        <div className="space-y-2">
          <Label className="sr-only">Website</Label>
          <Input
            value={draft.website}
            onChange={(e) => setDraft({ website: e.target.value })}
            placeholder="https://acme.com"
            disabled={disabled}
          />
        </div>
      </SettingsGroupItem>

      <SettingsGroupItem title="Support Email">
        <div className="space-y-2">
          <Label className="sr-only">Support email</Label>
          <Input
            type="email"
            value={draft.supportEmail}
            onChange={(e) => setDraft({ supportEmail: e.target.value })}
            placeholder="support@acme.com"
            disabled={disabled}
          />
        </div>
      </SettingsGroupItem>
    </>
  );

  return (
    <SettingsGroup>
      {disabled ? (
        <fieldset
          disabled
          className="flex flex-col divide-y divide-hairline disabled:opacity-100 dark:divide-polar-700"
        >
          {body}
        </fieldset>
      ) : (
        body
      )}
    </SettingsGroup>
  );
}
