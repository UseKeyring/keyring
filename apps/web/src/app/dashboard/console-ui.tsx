"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@keyring/ui/lib/utils";
import { KeyringMark } from "@keyring/ui/components/keyring-logo";
import { Avatar } from "@keyring/ui/components/profile-avatar";
import { Button } from "@keyring/ui/components/button";
import { SolarIcon, type SolarName } from "@keyring/ui/components/solar-icon";
import { sidebarMenuButtonVariants } from "@keyring/ui/components/sidebar";
import type { Permission, Role, RolePermission } from "@/hooks/useRbac";

/*
 * Shared console presentational components — the single source of truth for
 * console markup. dashboard-chrome and dashboard/page render these with live
 * data; the landing hero renders the same components with fixture data, so
 * the marketing mock and the app cannot drift apart.
 */

export type NavSubEntry = {
  /** Full path (workspace-prefixed, e.g. /dashboard/acme/settings/api-keys). */
  to: string;
  label: string;
  exact?: boolean;
  /** Read action required to see this entry; omitted = visible to members. */
  read?: string;
};

export type NavEntry = {
  /** Full path (workspace-prefixed by the chrome, e.g. /dashboard/acme/roles). */
  to: string;
  label: string;
  exact?: boolean;
  icon: SolarName;
  /** Read action required to see this entry; omitted = visible to members. */
  read?: string;
  /** Polar-style expandable children, rendered under the parent when active. */
  subs?: NavSubEntry[];
};

export function ConsoleWordmark() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2 py-2">
      <KeyringMark className="h-[18px] w-[18px] text-ink" />
      <span className="k-display text-[17px] tracking-[-0.02em] text-ink">Keyring</span>
      <span className="k-tag">console</span>
    </Link>
  );
}

/*
 * Icon-only sidebar mark. px-1.5 matches the nav links' horizontal inset
 * (their padding-inline longhand beats the merged p-2 shorthand, so both
 * resolve to the same 6px).
 */
export function ConsoleMark() {
  return (
    <Link href="/" aria-label="Keyring home" className="flex items-center px-1.5 py-2">
      <KeyringMark className="h-6 w-6" />
    </Link>
  );
}

export function ConsoleNavLink({
  href,
  icon,
  label,
  active,
  tabIndex,
  onNavigate,
  className,
  ref,
  ...rest
}: {
  href: string;
  icon: SolarName;
  label: string;
  active: boolean;
  tabIndex?: number;
  onNavigate?: () => void;
  className?: string;
  ref?: React.Ref<HTMLAnchorElement>;
  // Slot-injected props (button variants, data-*, tooltip handlers) flow
  // through untouched at runtime when rendered inside SidebarMenuButton.
} & Record<string, unknown>) {
  const { onClick: slotOnClick, ...slotRest } = rest as {
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  } & Record<string, unknown>;
  return (
    <Link
      prefetch
      href={href}
      ref={ref}
      tabIndex={tabIndex}
      data-sidebar="menu-button"
      data-size="default"
      data-active={active}
      onClick={(e) => {
        slotOnClick?.(e);
        if (!e.defaultPrevented) onNavigate?.();
      }}
      // Class order mirrors the Slot merge in SidebarMenuButton (button
      // variants first, link classes second) so standalone renders match
      // the app pixel-for-pixel.
      className={cn(
        sidebarMenuButtonVariants({ variant: "default", size: "default" }),
        "flex h-8 flex-row items-center border border-transparent px-1.5 font-normal! transition-colors group-data-[collapsible=icon]:px-0! group-data-[collapsible=icon]:justify-center!",
        active
          ? "border-hairline! bg-canvas! text-ink! shadow-[inset_2px_0_0_var(--a-accent)]"
          : "text-ink-muted hover:bg-pillar! hover:text-ink",
        className,
      )}
      {...slotRest}
    >
      <span
        className={cn(
          "flex flex-col items-center justify-center overflow-visible bg-transparent",
          active ? "k-accent" : "text-ink-subtle",
        )}
      >
        <SolarIcon name={icon} className="h-4 w-4" />
      </span>
      <span className="relative ml-2 overflow-visible text-[13px] group-data-[collapsible=icon]:hidden">
        {label}
      </span>
    </Link>
  );
}

export function ConsoleUserRow({
  email,
  displayName,
  avatarUrl,
}: {
  email: string;
  displayName?: string | null | undefined;
  avatarUrl?: string | null | undefined;
}) {
  return (
    <div className="flex w-full items-center gap-2 min-w-0 group-data-[collapsible=icon]:justify-center">
      <Avatar
        name={displayName || email || "?"}
        avatar_url={avatarUrl ?? null}
        className="h-6 w-6 shrink-0 border border-hairline"
      />
      <span className="min-w-0 truncate text-[12px] text-ink-muted group-data-[collapsible=icon]:hidden">
        {email}
      </span>
      <SolarIcon
        name="chevronDown"
        className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-subtle group-data-[collapsible=icon]:hidden"
      />
    </div>
  );
}

export function ConsoleMain({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pt-8 pb-8 md:px-10">
        {children}
      </div>
    </main>
  );
}

/** `[01] ROLES ------------` section rule, as on the public site. */
export function ConsoleSectionLabel({
  n,
  children,
  className,
}: {
  n: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("k-label k-rule", className)}>
      <span className="k-accent">[{n}]</span>
      <span>{children}</span>
    </div>
  );
}

export function OverviewHeader({ orgName }: { orgName: string | null }) {
  return (
    <div>
      <h1 className="whitespace-nowrap">Overview</h1>
      <p className="type-body-sm mt-2 text-ink-muted">
        {orgName
          ? `Access control for ${orgName} — actions compose into roles, granted to users.`
          : "Actions compose into roles, granted to users."}
      </p>
    </div>
  );
}

export type OverviewStat = {
  label: string;
  value: number;
  to: string;
  readable: boolean;
};

export function OverviewStats({ stats }: { stats: OverviewStat[] }) {
  return (
    <div className="k-cells grid-cols-2 lg:grid-cols-4">
      {stats.map((s, i) => {
        const cardClassName = "group block p-5 transition-colors md:p-6";
        const body = (
          <>
            <div className="flex items-center justify-between">
              <span className="k-label">
                <span className="k-dim">{String(i + 1).padStart(2, "0")} </span>
                {s.label}
              </span>
              {s.readable && (
                <span aria-hidden className="text-ink-subtle transition-colors group-hover:text-(--a-accent)">
                  →
                </span>
              )}
            </div>
            <div className="mt-6 text-5xl font-extralight tracking-tight text-ink tabular-nums">
              {s.readable ? s.value : "–"}
            </div>
          </>
        );
        return s.readable ? (
          <Link key={s.label} href={s.to} className={cardClassName}>
            {body}
          </Link>
        ) : (
          <div key={s.label} className={cardClassName}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export function OverviewMatrix({
  roles,
  perms,
  rolePerms,
  showEmptyHint,
}: {
  roles: Pick<Role, "id" | "name">[];
  perms: Pick<Permission, "id" | "slug">[];
  rolePerms: Pick<RolePermission, "role_id" | "permission_id">[];
  showEmptyHint?: boolean;
}) {
  return (
    <div className="space-y-4">
      <ConsoleSectionLabel n="02">Role matrix</ConsoleSectionLabel>
      <div className="overflow-x-auto border border-hairline">
        <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
          <thead>
            <tr className="k-hatch bg-pillar text-left">
              <th className="border-b border-hairline px-4 py-2.5">Action</th>
              {roles.map((r) => (
                <th key={r.id} className="border-b border-l border-hairline px-4 py-2.5 text-center">
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-ink">
            {perms.map((p) => (
              <tr key={p.id} className="border-t border-hairline first:border-t-0 hover:bg-pillar">
                <td className="px-4 py-2.5 pr-4">{p.slug}</td>
                {roles.map((r) => {
                  const on = rolePerms.some(
                    (rp) => rp.role_id === r.id && rp.permission_id === p.id,
                  );
                  return (
                    <td key={r.id} className="border-l border-hairline px-4 py-2.5 text-center">
                      <span className={on ? "k-accent" : "text-ink-subtle"}>{on ? "[x]" : "[ ]"}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
            {showEmptyHint && (
              <tr>
                <td className="px-4 py-8 text-ink-muted" colSpan={roles.length + 1}>
                  &gt; Nothing defined yet — start with Actions, then Roles.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClaudeLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("fill-current", className)} aria-hidden="true">
      <path d="M13.827 3.553a.96.96 0 0 0-1.654 0L4.59 17.518a.96.96 0 0 0 .827 1.435h2.822a.96.96 0 0 0 .827-.472l1.623-2.92h4.624l1.623 2.92a.96.96 0 0 0 .827.472h2.822a.96.96 0 0 0 .827-1.435L13.827 3.553Zm-1.82 7.747 1.488-2.678 1.488 2.678h-2.976Z" />
    </svg>
  );
}

function OpenAILogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("fill-current", className)} aria-hidden="true">
      <path d="M22.28 9.77a6 6 0 0 0-.52-5.18 6.05 6.05 0 0 0-6.49-2.77A6 6 0 0 0 10.6.5a6.06 6.06 0 0 0-5.78 4.04 6 6 0 0 0-4.17 2.76 6.05 6.05 0 0 0 .72 7.07 6 6 0 0 0 .52 5.18 6.05 6.05 0 0 0 6.49 2.77 6 6 0 0 0 4.67 1.32 6.06 6.06 0 0 0 5.78-4.04 6 6 0 0 0 4.17-2.76 6.05 6.05 0 0 0-.72-7.07Zm-9.39 12.72a4.54 4.54 0 0 1-2.93-1.07c.04-.02.13-.07.18-.11l3.85-2.22a.76.76 0 0 0 .38-.66v-5.43l1.63.94a.07.07 0 0 1 .04.05v4.54a4.57 4.57 0 0 1-3.15 3.96ZM3.87 18.06a4.55 4.55 0 0 1-.54-3.1 4.57 4.57 0 0 1 1.76-2.61l.17.1 3.85 2.22a.76.76 0 0 0 .76 0l4.7-2.71v1.88a.07.07 0 0 1-.03.06l-3.93 2.27a4.57 4.57 0 0 1-6.74-1.97Zm-1.2-8.54a4.55 4.55 0 0 1 2.39-2.03c0 .05.07.12.11.19l1.93 3.34a.76.76 0 0 0 .38.33l4.7 2.71-1.63.94a.07.07 0 0 1-.07 0L6.55 12.7A4.57 4.57 0 0 1 2.67 9.52Zm15.34 2.2a.76.76 0 0 0-.38-.33l-4.7-2.71 1.63-.94a.07.07 0 0 1 .07 0l3.93 2.27a4.57 4.57 0 0 1 1.93 6.64 4.55 4.55 0 0 1-2.39 2.03c0-.05-.07-.12-.11-.19l-1.93-3.34Zm1.96-3.8a4.55 4.55 0 0 1 .54 3.1 4.57 4.57 0 0 1-1.76 2.61c-.05-.03-.12-.07-.17-.1l-3.85-2.22a.76.76 0 0 0-.76 0l-4.7 2.71V10.2a.07.07 0 0 1 .03-.06l3.93-2.27a4.57 4.57 0 0 1 6.74 1.97Zm-9.1-8.35a4.57 4.57 0 0 1 3.15 3.96c-.04.02-.13.07-.18.11L10.02 5.9a.76.76 0 0 0-.38.66v5.43l-1.63-.94a.07.07 0 0 1-.04-.05V6.46a4.57 4.57 0 0 1 3.15-3.96Zm-1.85 7.15 2.1-1.21 2.1 1.21v2.42l-2.1 1.21-2.1-1.21v-2.42Z"/>
    </svg>
  );
}

function GeminiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("fill-current", className)} aria-hidden="true">
      <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z"/>
    </svg>
  );
}

function CursorLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("fill-current", className)} aria-hidden="true">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
    </svg>
  );
}

export function OverviewSetupSteps({
  base,
  permsCount,
  rolesCount,
  usersCount,
  keysCount,
  orgName,
  orgSlug,
  existingRoles,
  existingActions,
  subjectCount,
  grantCount,
}: {
  base: string;
  permsCount: number;
  rolesCount: number;
  usersCount: number;
  keysCount: number;
  orgName: string;
  orgSlug: string;
  existingRoles: string[];
  existingActions: string[];
  subjectCount: number;
  grantCount: number;
}) {
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [showAiPrompt, setShowAiPrompt] = useState(false);

  useEffect(() => {
    try {
      const storageKey = `keyring_skipped_steps_${orgSlug}`;
      const stored = localStorage.getItem(storageKey);
      if (stored) setSkipped(JSON.parse(stored));
    } catch {}
  }, [orgSlug]);

  const toggleSkip = (id: string) => {
    const next = { ...skipped, [id]: !skipped[id] };
    setSkipped(next);
    try {
      const storageKey = `keyring_skipped_steps_${orgSlug}`;
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  };

  const rawSteps = [
    {
      id: "actions",
      title: "Define Actions",
      description: "Create custom permission actions for your application.",
      autoCompleted: permsCount > 0,
      href: `${base}/actions`,
      actionText: "Manage actions",
    },
    {
      id: "roles",
      title: "Create Roles",
      description: "Group actions into reusable customer roles like admin or viewer.",
      autoCompleted: rolesCount > 0,
      href: `${base}/roles`,
      actionText: "Manage roles",
    },
    {
      id: "users",
      title: "Add Users & Assign Roles",
      description: "Add end-user subjects and assign roles to grant permissions.",
      autoCompleted: usersCount > 0,
      href: `${base}/users`,
      actionText: "Manage users",
    },
    {
      id: "keys",
      title: "Issue an API Key",
      description: "Create an API key for your backend to evaluate permissions.",
      autoCompleted: keysCount > 0,
      href: `${base}/settings/api-keys`,
      actionText: "Manage API keys",
    },
  ];

  const steps = rawSteps.map((s) => ({
    ...s,
    isSkipped: !!skipped[s.id] && !s.autoCompleted,
    isDone: s.autoCompleted || !!skipped[s.id],
  }));

  const completedCount = steps.filter((s) => s.isDone).length;
  const progressPercent = Math.round((completedCount / steps.length) * 100);

  const aiPromptText = [
    `I am using Keyring (an RBAC & permissions management system) to control access in my application.`,
    ``,
    `## MY WORKSPACE`,
    `- Workspace name: ${orgName || "(not set)"}`,
    `- Workspace slug: ${orgSlug || "(not set)"}`,
    existingRoles.length > 0
      ? `- Existing roles (${existingRoles.length}): ${existingRoles.join(", ")}`
      : `- Existing roles: none yet`,
    existingActions.length > 0
      ? `- Existing actions (${existingActions.length}): ${existingActions.join(", ")}`
      : `- Existing actions: none yet`,
    `- Subjects (end-users): ${subjectCount}`,
    `- Active grants: ${grantCount}`,
    `- API keys issued: ${keysCount}`,
    ``,
    `## MANAGEMENT API ENDPOINTS`,
    `- Hosted at https://usekeyring.dev. Docs: https://usekeyring.dev/docs. Prefer @usekeyring/sdk with baseUrl "https://usekeyring.dev". Secret key kr_sk_… (server): create/list/check/grant/revoke + mint subject tokens. Publishable key kr_pk_… (browser): check only with X-Keyring-Subject-Token.`,
    `- Base URL: https://usekeyring.dev/api/v1 (Authorization: Bearer <KEY>)`,
    `- Create Action: POST https://usekeyring.dev/api/v1/permissions { "slug": "<resource.action>", "name": "<Name>", "category"?: "<Category>" } (scope actions.write; idempotent)`,
    `- Create Role: POST https://usekeyring.dev/api/v1/roles { "slug": "<role-slug>", "name": "<Name>", "permissions"?: ["<ACTION_SLUG>"] } (scope roles.write; idempotent; actions must exist first; links are additive)`,
    `- Check (secret): GET https://usekeyring.dev/api/v1/check?subject=<USER_ID>&permission=<ACTION_SLUG>`,
    `- Check (publishable): GET https://usekeyring.dev/api/v1/check?permission=<ACTION_SLUG> + X-Keyring-Subject-Token`,
    `- Mint subject token: POST https://usekeyring.dev/api/v1/subject-tokens { "subject": "<USER_ID>", "ttl_seconds"?: number }`,
    `- Grant Role: POST https://usekeyring.dev/api/v1/grants { "role": "<ROLE_SLUG>", "subject": "<USER_ID>" }`,
    `- Temporary grant (e.g. 5 min): POST https://usekeyring.dev/api/v1/grants { "role": "<ROLE_SLUG>", "subject": "<USER_ID>", "ttl_seconds": 300 } (or "expires_at": "<ISO>"); check() denies after expiry, no revoke needed`,
    `- Revoke Role: DELETE https://usekeyring.dev/api/v1/grants { "role": "<ROLE_SLUG>", "subject": "<USER_ID>" }`,
    `- List Customer Roles: GET https://usekeyring.dev/api/v1/roles`,
    `- List Actions: GET https://usekeyring.dev/api/v1/permissions`,
    ``,
    `## AGENT INSTRUCTIONS`,
    `- Audit my application codebase to identify required permission actions (e.g., "documents.read", "billing.manage").`,
    existingActions.length > 0
      ? `- I already have these actions defined: ${existingActions.join(", ")}. Add any missing ones and remove unused ones.`
      : `- Create the permission actions my app needs via the API.`,
    existingRoles.length > 0
      ? `- I already have these roles defined: ${existingRoles.join(", ")}. Adjust role-action mappings if needed.`
      : `- Create customer roles (e.g., "admin", "editor", "viewer") grouping those permission actions.`,
    `- Bootstrap order with a secret key holding check + grants.write + roles.write + actions.write (+ subject_tokens.write if minting browser tokens): create actions first, then roles with permissions, then grants. Or @usekeyring/sdk with baseUrl "https://usekeyring.dev": createPermission() → createRole({ permissions }) → grantRole() → check(). Key scopes (check, grants.write, roles.read, roles.write, actions.read, actions.write, subject_tokens.write) gate each endpoint. Publishable keys are check-only with subject tokens.`,
  ].join("\n");

  const copyPrompt = () => {
    navigator.clipboard.writeText(aiPromptText);
    toast.success("AI Agent Setup Prompt copied to clipboard!");
  };

  const barCells = 20;
  const filled = Math.round((completedCount / steps.length) * barCells);

  return (
    <div className="space-y-4">
      <ConsoleSectionLabel n="01">Get started</ConsoleSectionLabel>
      <div className="border border-hairline">
        <div className="flex flex-col gap-4 border-b border-hairline p-5 md:flex-row md:items-center md:justify-between md:p-6">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="k-display text-[22px] text-ink">Get started with Keyring</h2>
              {completedCount === steps.length && (
                <span className="k-tag k-tag-ok">Setup complete</span>
              )}
            </div>
            <p className="type-body-sm mt-1 text-ink-muted">
              Complete or skip these steps, or copy the prompt below into your AI agent to automate setup.
            </p>
          </div>
          <div className="flex flex-col items-start gap-1 md:items-end">
            <div className="text-[12px] whitespace-pre text-ink-muted" aria-hidden>
              <span className="k-dim">[</span>
              <span className="k-accent">{"#".repeat(filled)}</span>
              <span className="k-dim">{"-".repeat(barCells - filled)}</span>
              <span className="k-dim">]</span> {progressPercent}%
            </div>
            <div className="text-[11px] text-ink-subtle">
              {completedCount} of {steps.length} completed
            </div>
          </div>
        </div>

        <div className="k-cells grid-cols-1 border-0 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, idx) => (
            <div
              key={step.id}
              className={`flex flex-col justify-between p-5 transition-colors ${
                step.isSkipped ? "k-hatch" : step.isDone ? "bg-pillar!" : ""
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="k-label">
                    <span className={step.isDone ? "k-dim" : "k-accent"}>[0{idx + 1}]</span> step
                  </span>
                  <div className="flex items-center gap-2">
                    {!step.autoCompleted && (
                      <button
                        type="button"
                        onClick={() => toggleSkip(step.id)}
                        className="text-[11px] text-ink-muted hover:text-ink hover:underline"
                      >
                        {step.isSkipped ? "unskip" : "skip"}
                      </button>
                    )}
                    <span
                      className={`text-[12px] ${
                        step.autoCompleted ? "k-ok" : step.isSkipped ? "text-ink-subtle" : "text-ink-subtle"
                      }`}
                    >
                      {step.isDone ? "[✓]" : "[ ]"}
                    </span>
                  </div>
                </div>
                <h3 className={`mt-4 text-[13.5px] ${step.isDone ? "text-ink-muted" : "text-ink"}`}>
                  {step.title}
                  {step.isSkipped && <span className="ml-1.5 text-[10.5px] text-ink-subtle">(skipped)</span>}
                </h3>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{step.description}</p>
              </div>
              <div className="mt-5">
                <Link href={step.href} className="k-link inline-flex items-center gap-1 text-[12px]">
                  {step.actionText} →
                </Link>
              </div>
            </div>
          ))}
        </div>

        {/* AI Agent Setup Prompt */}
        <div className="border-t border-hairline p-5 md:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-[13.5px] text-ink">
                <span className="k-accent">&gt;_</span> Set up using an AI agent
              </h3>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                Paste this prompt into Antigravity, Cursor, Claude, or ChatGPT to auto-configure your actions, roles, and backend middleware.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowAiPrompt((v) => !v)}
                className="text-xs"
              >
                {showAiPrompt ? "Hide prompt" : "View prompt"}
              </Button>
              <Button type="button" size="sm" onClick={copyPrompt} className="text-xs">
                Copy AI prompt
              </Button>
            </div>
          </div>

          {showAiPrompt && (
            <div className="mt-4 border border-hairline bg-pillar">
              <div className="k-hatch flex justify-between border-b border-hairline px-4 py-2 text-[11px] text-ink-muted">
                <span>setup-prompt.md</span>
                <span>{aiPromptText.split("\n").length} lines</span>
              </div>
              <pre className="max-h-[420px] overflow-auto p-4 text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-muted">
                {aiPromptText}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
