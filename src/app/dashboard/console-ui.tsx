"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { KeyringMark } from "@/components/ui/keyring-logo";
import { Avatar } from "@/components/ui/profile-avatar";
import { SolarIcon, type SolarName } from "@/components/ui/solar-icon";
import { sidebarMenuButtonVariants } from "@/components/ui/sidebar";
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
        "flex flex-row items-center rounded-lg border border-transparent px-1.5 transition-colors",
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
      <span className="relative ml-2 overflow-visible text-sm font-medium">{label}</span>
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
    <>
      <Avatar
        name={displayName || email || "?"}
        avatar_url={avatarUrl ?? null}
        className="h-6 w-6"
      />
      <span className="min-w-0 truncate">{email}</span>
      <SolarIcon name="chevronDown" className="ml-auto h-4 w-4" />
    </>
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
