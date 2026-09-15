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

export type NavEntry = {
  /** Full path (workspace-prefixed by the chrome, e.g. /dashboard/acme/roles). */
  to: string;
  label: string;
  exact?: boolean;
  icon: SolarName;
  /** Read action required to see this entry; omitted = visible to members. */
  read?: string;
};

export function ConsoleWordmark() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2 py-2">
      <KeyringMark className="h-6 w-6" />
      <span className="type-label text-[15px] text-ink">Keyring</span>
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
        "flex flex-row items-center rounded-lg border border-transparent px-1.5 transition-colors group-data-[collapsible=icon]:px-0! group-data-[collapsible=icon]:justify-center!",
        active
          ? "border-hairline! bg-pillar! text-ink! shadow-xs dark:border-polar-800! dark:bg-polar-900! dark:text-white!"
          : "text-ink-muted hover:text-ink dark:text-polar-500 dark:hover:text-polar-200",
        className,
      )}
      {...slotRest}
    >
      <span
        className={cn(
          "flex flex-col items-center justify-center overflow-visible rounded-full bg-transparent text-[15px]",
          active && "text-ink! dark:text-white!",
        )}
      >
        <SolarIcon name={icon} className="h-4 w-4" />
      </span>
      <span className="relative ml-2 overflow-visible text-sm font-medium group-data-[collapsible=icon]:hidden">
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
        className="h-6 w-6 shrink-0"
      />
      <span className="min-w-0 truncate group-data-[collapsible=icon]:hidden">{email}</span>
      <SolarIcon name="chevronDown" className="ml-auto h-4 w-4 shrink-0 group-data-[collapsible=icon]:hidden" />
    </div>
  );
}

export function ConsoleMain({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl border border-hairline bg-white shadow-xs dark:border-polar-800 dark:bg-polar-900">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pt-8 pb-8 md:px-8">
        {children}
      </div>
    </main>
  );
}

export function OverviewHeader({ orgName }: { orgName: string | null }) {
  return (
    <div>
      <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Overview</h1>
      <p className="type-body-sm mt-1 text-ink-muted">
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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((s) => {
        const cardClassName =
          "rounded-2xl border border-hairline bg-pillar p-6 dark:border-transparent dark:bg-polar-800";
        const body = (
          <>
            <div className="type-body-sm text-ink-muted">{s.label}</div>
            <div className="mt-2 text-5xl font-extralight tracking-tight text-ink tabular-nums">
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
    <div className="rounded-2xl border border-hairline bg-pillar p-6 md:p-8 dark:border-transparent dark:bg-polar-800">
      <div className="type-body-sm text-ink">Role matrix</div>
      <div className="mt-4 overflow-x-auto">
        <table className="type-body-sm w-full min-w-[560px]">
          <thead>
            <tr className="type-mono text-left text-ink-muted">
              <th className="pb-3 font-normal">Action</th>
              {roles.map((r) => (
                <th key={r.id} className="pb-3 font-normal">
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-ink">
            {perms.map((p) => (
              <tr key={p.id} className="border-t border-hairline">
                <td className="py-3 pr-4">{p.slug}</td>
                {roles.map((r) => {
                  const on = rolePerms.some(
                    (rp) => rp.role_id === r.id && rp.permission_id === p.id,
                  );
                  return (
                    <td key={r.id} className="py-3">
                      <span className={on ? "text-ink" : "text-ink-subtle"}>{on ? "✓" : "—"}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
            {showEmptyHint && (
              <tr>
                <td className="py-6 text-ink-muted" colSpan={roles.length + 1}>
                  Nothing defined yet — start with Actions, then Roles.
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
      href: `${base}/settings`,
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
    `- Prefer @keyring/sdk. Secret key kr_sk_… (server): grant/revoke/list/check + mint subject tokens. Publishable key kr_pk_… (browser): check only with X-Keyring-Subject-Token.`,
    `- Base URL: /api/v1 (Authorization: Bearer <KEY>)`,
    `- Check (secret): GET /api/v1/check?subject=<USER_ID>&permission=<ACTION_SLUG>`,
    `- Check (publishable): GET /api/v1/check?permission=<ACTION_SLUG> + X-Keyring-Subject-Token`,
    `- Mint subject token: POST /api/v1/subject-tokens { "subject": "<USER_ID>", "ttl_seconds"?: number }`,
    `- Grant Role: POST /api/v1/grants { "role": "<ROLE_SLUG>", "subject": "<USER_ID>" }`,
    `- Revoke Role: DELETE /api/v1/grants { "role": "<ROLE_SLUG>", "subject": "<USER_ID>" }`,
    `- List Customer Roles: GET /api/v1/roles`,
    `- List Actions: GET /api/v1/permissions`,
    ``,
    `## AGENT INSTRUCTIONS`,
    `- Audit my application codebase to identify required permission actions (e.g., "documents.read", "billing.manage").`,
    existingActions.length > 0
      ? `- I already have these actions defined: ${existingActions.join(", ")}. Add any missing ones and remove unused ones.`
      : `- Create the permission actions my app needs via the API.`,
    existingRoles.length > 0
      ? `- I already have these roles defined: ${existingRoles.join(", ")}. Adjust role-action mappings if needed.`
      : `- Create customer roles (e.g., "admin", "editor", "viewer") grouping those permission actions.`,
    `- Implement backend middleware with the secret key (or @keyring/sdk) calling /api/v1/check to enforce permissions. Use publishable keys only for frontend UX checks with subject tokens.`,
  ].join("\n");

  const copyPrompt = () => {
    navigator.clipboard.writeText(aiPromptText);
    toast.success("AI Agent Setup Prompt copied to clipboard!");
  };

  return (
    <div className="rounded-2xl border border-hairline bg-pillar p-6 md:p-8 dark:border-transparent dark:bg-polar-800 space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="type-body-lg font-medium text-ink">Get started with Keyring</h2>
            {completedCount === steps.length && (
              <span className="type-mono rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                Setup Complete
              </span>
            )}
          </div>
          <p className="type-body-sm mt-1 text-ink-muted">
            Complete or skip these steps, or copy the prompt below into your AI agent to automate setup.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 md:items-end">
          <div className="type-mono text-xs text-ink-muted">
            {completedCount} of {steps.length} completed ({progressPercent}%)
          </div>
          <div className="h-1.5 w-36 overflow-hidden rounded-full bg-hairline dark:bg-polar-700">
            <div
              className="h-full bg-ink transition-all duration-300 dark:bg-polar-100"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, idx) => (
          <div
            key={step.id}
            className={`flex flex-col justify-between rounded-xl border p-5 transition-colors ${
              step.isDone
                ? "border-hairline bg-canvas/60 dark:border-polar-700/50 dark:bg-polar-900/40"
                : "border-hairline bg-canvas dark:border-polar-700 dark:bg-polar-900"
            }`}
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="type-mono text-xs text-ink-muted">Step 0{idx + 1}</span>
                <div className="flex items-center gap-1.5">
                  {!step.autoCompleted && (
                    <button
                      type="button"
                      onClick={() => toggleSkip(step.id)}
                      className="type-mono text-[11px] text-ink-muted hover:text-ink hover:underline"
                    >
                      {step.isSkipped ? "Unskip" : "Skip"}
                    </button>
                  )}
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                      step.autoCompleted
                        ? "bg-ink text-white dark:bg-white dark:text-polar-950"
                        : step.isSkipped
                        ? "bg-hairline text-ink-muted dark:bg-polar-700"
                        : "border border-hairline text-ink-muted dark:border-polar-600"
                    }`}
                  >
                    {step.isDone ? "✓" : idx + 1}
                  </span>
                </div>
              </div>
              <h3 className="mt-3 font-medium text-ink">
                {step.title}
                {step.isSkipped && (
                  <span className="ml-1.5 type-mono text-[10px] text-ink-muted">(Skipped)</span>
                )}
              </h3>
              <p className="type-body-sm mt-1 text-xs leading-relaxed text-ink-muted">
                {step.description}
              </p>
            </div>
            <div className="mt-4 pt-2">
              <Link
                href={step.href}
                className="type-body-sm inline-flex items-center gap-1 text-xs font-medium text-catppuccin-blue hover:underline"
              >
                {step.actionText} →
              </Link>
            </div>
          </div>
        ))}
      </div>


      {/* AI Agent Setup Prompt Card */}
      <div className="rounded-xl border border-hairline bg-canvas p-5 dark:border-polar-700 dark:bg-polar-900">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="type-body-sm font-medium text-ink">Set up using an AI Agent</h3>
                {/* badges removed */}
              </div>
              <p className="type-body-sm text-xs text-ink-muted mt-0.5">
                Paste this prompt into Antigravity, Cursor, Claude, or ChatGPT to auto-configure your actions, roles, and backend middleware.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAiPrompt((v) => !v)}
              className="text-xs"
            >
              {showAiPrompt ? "Hide Prompt" : "View Prompt"}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={copyPrompt}
              className="text-xs"
            >
              Copy AI Prompt
            </Button>
          </div>
        </div>

        {showAiPrompt && (
          <div className="mt-4">
            <div className="relative rounded-lg border border-hairline bg-pillar p-4 dark:border-polar-700 dark:bg-polar-950">
              <pre className="type-mono whitespace-pre-wrap text-xs text-ink-muted leading-relaxed">
                {aiPromptText}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
