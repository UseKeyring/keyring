"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useOrganization";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { AvatarUpload } from "@/components/ui/avatar-upload";
import { Button } from "@/components/ui/button";
import { CopyToClipboardInput } from "@/components/ui/copy-to-clipboard-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroup, SettingsGroupItem } from "@/components/ui/settings-group";

function splitName(full: string | null | undefined): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

function joinName(first: string, last: string): string | null {
  const full = `${first.trim()} ${last.trim()}`.trim();
  return full || null;
}

function ProfileForm() {
  const { user } = useAuth();
  const { data: profile } = useMyProfile();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);

  const initial = splitName(
    profile?.full_name ?? (user?.user_metadata?.["full_name"] as string | undefined) ?? null,
  );
  const [first, setFirst] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const cur = {
    first: first ?? initial.first,
    last: last ?? initial.last,
    avatarUrl: avatarUrl ?? profile?.avatar_url ?? "",
  };
  const pristine = {
    first: initial.first,
    last: initial.last,
    avatarUrl: profile?.avatar_url ?? "",
  };
  const dirty = JSON.stringify(cur) !== JSON.stringify(pristine);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await getSupabaseBrowserClient()
        .from("profiles")
        .upsert(
          {
            id: user.id,
            email: user.email ?? profile?.email ?? "",
            full_name: joinName(cur.first, cur.last),
            avatar_url: cur.avatarUrl.trim() || null,
          },
          { onConflict: "id" },
        );
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["profiles"] });
      toast.success("Profile saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <SettingsGroup>
        <div className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-[auto_1fr_1fr] sm:gap-x-5">
          <div>
            <Label className="mb-2 block">Photo</Label>
            <AvatarUpload
              name={`${cur.first} ${cur.last}`.trim() || user?.email || "?"}
              value={cur.avatarUrl}
              onChange={(url) => setAvatarUrl(url)}
              storagePrefix="avatars"
              noun="Photo"
            />
          </div>
          <div>
            <Label className="mb-2 block" htmlFor="account-first-name">
              First name
            </Label>
            <Input
              id="account-first-name"
              value={cur.first}
              onChange={(e) => setFirst(e.target.value)}
              placeholder="Jane"
              autoComplete="given-name"
            />
          </div>
          <div>
            <Label className="mb-2 block" htmlFor="account-last-name">
              Last name
            </Label>
            <Input
              id="account-last-name"
              value={cur.last}
              onChange={(e) => setLast(e.target.value)}
              placeholder="Doe"
              autoComplete="family-name"
            />
          </div>
        </div>
      </SettingsGroup>
      {dirty && (
        <div className="mt-4 flex flex-row items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  );
}

function EmailItem() {
  const { user } = useAuth();
  const [email, setEmail] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const current = user?.email ?? "";
  const next = (email ?? current).trim();
  const dirty = next !== current;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || !next) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      toast.error("Enter a valid email address");
      return;
    }
    setSaving(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.updateUser({ email: next });
      if (error) throw error;
      setEmail(null);
      toast.success("Confirmation sent — check your new inbox to confirm");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change email");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupItem
      title="Email"
      description="Your sign-in address. Changing it sends a confirmation to the new inbox."
    >
      <form onSubmit={submit} className="flex w-full max-w-xs gap-2">
        <Input
          type="email"
          value={email ?? current}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@acme.com"
          autoComplete="email"
        />
        {dirty && (
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </form>
    </SettingsGroupItem>
  );
}

function PasswordItem() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const dirty = password.length > 0 || confirm.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setSaving(true);
    try {
      const { error } = await getSupabaseBrowserClient().auth.updateUser({ password });
      if (error) throw error;
      setPassword("");
      setConfirm("");
      toast.success("Password updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupItem
      title="Password"
      description="At least 8 characters. You stay signed in on this device."
    >
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-2">
        <div className="space-y-2">
          <Label className="sr-only" htmlFor="account-new-password">
            New password
          </Label>
          <Input
            id="account-new-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password"
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-2">
          <Label className="sr-only" htmlFor="account-confirm-password">
            Confirm new password
          </Label>
          <Input
            id="account-confirm-password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm new password"
            autoComplete="new-password"
          />
        </div>
        {dirty && (
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Update password"}
            </Button>
          </div>
        )}
      </form>
    </SettingsGroupItem>
  );
}

function ThemeItem() {
  const { theme, setTheme } = useTheme();

  return (
    <SettingsGroupItem
      title="Theme"
      description="Override your browser's preferred theme settings."
    >
      <Select value={theme ?? "system"} onValueChange={setTheme}>
        <SelectTrigger className="w-[160px] rounded-full">
          <SelectValue placeholder="System theme" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">System</SelectItem>
          <SelectItem value="light">Light</SelectItem>
          <SelectItem value="dark">Dark</SelectItem>
        </SelectContent>
      </Select>
    </SettingsGroupItem>
  );
}

/*
 * Personal account settings — Polar `account/preferences` pattern
 * (personal info + general + danger zone), trimmed to what this console
 * owns: profile, sign-in email, password and theme. Rendered on the
 * standalone account page — it is personal, never workspace-gated.
 */
export function AccountSection() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-body-lg font-medium text-ink">Account</h2>
        <p className="type-body-sm mt-1 text-ink-muted">Your personal sign-in and profile.</p>
      </div>

      <ProfileForm />

      <SettingsGroup>
        <SettingsGroupItem title="User ID" description="Your unique identifier in this console">
          <CopyToClipboardInput value={user?.id ?? ""} variant="mono" ariaLabel="User identifier" />
        </SettingsGroupItem>
        <EmailItem />
        <PasswordItem />
        <ThemeItem />
      </SettingsGroup>
    </div>
  );
}
