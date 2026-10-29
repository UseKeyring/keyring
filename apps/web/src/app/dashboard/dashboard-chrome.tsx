"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { useAuth } from "@/hooks/useAuth";
import { useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization, useMyWorkspaces } from "@/hooks/useOrganization";
import { useMyProfile } from "@/hooks/useOrganization";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@keyring/ui/components/dropdown-menu";
import { Avatar } from "@keyring/ui/components/profile-avatar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@keyring/ui/components/sidebar";
import { cn } from "@keyring/ui/lib/utils";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import { Spotlight, SpotlightButton, openSpotlight } from "./spotlight";
import {
  ConsoleNavLink,
  ConsoleUserRow,
  ConsoleWordmark as Wordmark,
  type NavEntry,
} from "./console-ui";

/** Workspace base path (/dashboard/<slug>), from the URL with org fallback. */
export function useDashboardBase() {
  const params = useParams();
  const { org } = useMyOrganization();
  const slug = (params?.["orgSlug"] as string | string[] | undefined) ?? org.data?.slug ?? null;
  const flat = Array.isArray(slug) ? slug[0] : slug;
  return flat ? `/dashboard/${flat}` : "/dashboard";
}

type NavSection = { label: string; items: NavEntry[] };

function buildNav(base: string): { overview: NavEntry; sections: NavSection[] } {
  return {
    overview: { to: base, label: "Overview", exact: true, icon: "overview" },
    sections: [
      {
        label: "Manage",
        items: [
          { to: `${base}/actions`, label: "Actions", icon: "actions", read: "permissions.read" },
          { to: `${base}/roles`, label: "Roles", icon: "roles", read: "roles.read" },
          { to: `${base}/spaces`, label: "Spaces", icon: "overview", read: "roles.read" },
          { to: `${base}/members`, label: "Members", icon: "members", read: "members.read" },
          { to: `${base}/users`, label: "Users", icon: "users", read: "users.read" },
        ],
      },
      {
        label: "System",
        items: [
          { to: `${base}/telemetry`, label: "Telemetry", icon: "activity", read: "telemetry.read" },
          { to: `${base}/audit`, label: "Activity", icon: "activity", read: "audit.read" },
          {
            to: `${base}/settings`,
            label: "Settings",
            icon: "settings",
            subs: [
              { to: `${base}/settings`, label: "General", exact: true },
              { to: `${base}/settings/api-keys`, label: "API keys" },
              { to: `${base}/settings/webhooks`, label: "Webhooks" },
              { to: `${base}/settings/integrations`, label: "Integrations" },
              { to: `${base}/settings/telemetry`, label: "Telemetry" },
            ],
          },
        ],
      },
    ],
  };
}

/** Polar-style active matching: exact links match only themselves,
 *  prefix links match themselves + any deeper path. */
function isLinkActive(pathname: string, to: string, exact?: boolean): boolean {
  if (exact) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

function NavItem({ item }: { item: NavEntry }) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = isLinkActive(pathname, item.to, item.exact);
  const subs = item.subs ?? [];

  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip={item.label} asChild isActive={active}>
        <ConsoleNavLink
          href={item.to}
          icon={item.icon}
          label={item.label}
          active={active}
          onNavigate={() => {
            if (isMobile) setOpenMobile(false);
          }}
        />
      </SidebarMenuButton>
      {subs.length > 0 && active && (
        <SidebarMenuSub className="mx-0 my-1 translate-x-0 gap-y-0 border-l-0 px-0 py-0">
          {subs.map((sub, i) => {
            const subActive = isLinkActive(pathname, sub.to, sub.exact);
            const last = i === subs.length - 1;
            return (
              <SidebarMenuSubItem key={sub.to}>
                <Link
                  prefetch
                  href={sub.to}
                  aria-current={subActive ? "page" : undefined}
                  onClick={() => {
                    if (isMobile) setOpenMobile(false);
                  }}
                  className={cn(
                    "flex h-7 flex-row items-center gap-x-2 pl-[15px] text-[12.5px] transition-colors hover:text-ink",
                    subActive ? "text-ink" : "text-ink-muted",
                  )}
                >
                  <span aria-hidden className="k-tree text-ink-subtle">
                    {last ? "└─" : "├─"}
                  </span>
                  <span className="relative">{sub.label}</span>
                  {subActive && <span aria-hidden className="k-accent ml-auto pr-3">●</span>}
                </Link>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

function WorkspaceSwitcher() {
  const router = useRouter();
  const { orgId } = useMyOrganization();
  const workspaces = useMyWorkspaces();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = (workspaces.data ?? []).find((w) => w.organization_id === orgId);

  const go = (slug: string) => {
    if (isMobile) setOpenMobile(false);
    router.push(`/dashboard/${slug}`);
  };

  const goNew = () => {
    if (isMobile) setOpenMobile(false);
    router.push("/dashboard/new");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch workspace"
          className="flex h-9 w-full items-center gap-2.5 border border-hairline bg-canvas px-2 text-left transition-colors hover:border-surface-2 hover:bg-pillar data-[state=open]:border-surface-2"
        >
          <Avatar
            name={active?.organizations?.name ?? "?"}
            avatar_url={active?.organizations?.avatar_url ?? null}
            className="h-5 w-5 border border-hairline"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
            {active?.organizations?.name ?? "Workspaces"}
          </span>
          <SolarIcon name="chevronDown" className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="w-(--radix-popper-anchor-width) min-w-[220px]"
      >
        <DropdownMenuLabel>
          <span className="k-label block">Workspaces</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(workspaces.data ?? []).map((w) => {
          const isActive = w.organization_id === orgId;
          const slug = w.organizations?.slug;
          if (!slug) return null;
          return (
            <DropdownMenuItem
              key={w.organization_id}
              className="flex flex-row items-center gap-x-2"
              onClick={() => go(slug)}
            >
              <Avatar
                name={w.organizations?.name ?? "?"}
                avatar_url={w.organizations?.avatar_url ?? null}
                className="h-5 w-5"
              />
              <span className="min-w-0 flex-1 truncate">{w.organizations?.name}</span>
              {isActive && <SolarIcon name="check" className="h-4 w-4 shrink-0" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="flex flex-row items-center gap-x-2"
          onClick={() => goNew()}
        >
          <SolarIcon name="plus" className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate">Add workspace</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConsoleSidebar() {
  const { user, signOut } = useAuth();
  const { org } = useMyOrganization();
  const profile = useMyProfile();
  const { can, loading: accessLoading } = useMyAccess();
  const { theme, setTheme } = useTheme();
  const base = useDashboardBase();
  const { overview, sections } = buildNav(base);
  const roleLabel = org.data?.created_by === user?.id ? "owner" : "member";
  // While access resolves, show everything to avoid nav flicker; entries
  // the viewer may not read stay reachable but render their own deny panel.
  const visible = (items: NavEntry[]) =>
    accessLoading
      ? items
      : items
          .filter((i) => !i.read || can(i.read))
          .map((i) =>
            i.subs
              ? { ...i, subs: i.subs.filter((s) => !s.read || can(s.read)) }
              : i,
          );

  return (
    <Sidebar variant="sidebar" collapsible="icon" className="k-grain">
      <SidebarHeader className="flex h-12 shrink-0 flex-row items-center gap-1.5 border-b border-hairline px-2 py-0 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:py-0">
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <WorkspaceSwitcher />
        </div>
        <SidebarTrigger className="h-8 w-8 shrink-0 text-ink-muted hover:text-ink" />
      </SidebarHeader>

      <SidebarContent className="gap-1 px-0 pt-3 pb-3">
        <div className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
          <SpotlightButton variant="bar" />
        </div>
        <SidebarGroup className="py-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem item={overview} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {sections.map((section, si) => {
          const items = visible(section.items);
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={section.label} className="py-1">
              <SidebarGroupLabel className="k-label k-rule h-8 gap-2 px-1.5 text-[10.5px] font-normal">
                <span className="k-accent">[{String(si + 1).padStart(2, "0")}]</span>
                <span>{section.label}</span>
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => (
                    <NavItem key={item.to} item={item} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="border-t border-hairline p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton>
                  <ConsoleUserRow
                    email={user?.email ?? ""}
                    displayName={profile.data?.full_name}
                    avatarUrl={profile.data?.avatar_url}
                  />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="center"
                className="w-(--radix-popper-anchor-width) min-w-[200px]"
              >
                <DropdownMenuLabel>
                  <span className="block truncate text-[12.5px] font-normal text-ink">{user?.email}</span>
                  <span className="k-label block font-normal">{roleLabel}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link
                    href="/dashboard/account"
                    prefetch
                    className="flex flex-row items-center gap-x-2"
                  >
                    <SolarIcon name="settings" className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate">Account settings</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {(
                  [
                    { value: "light", title: "Light mode", icon: "sun" },
                    { value: "dark", title: "Dark mode", icon: "moon" },
                    { value: "system", title: "System theme", icon: "monitor" },
                  ] as const
                ).map(({ value, title, icon }) => (
                  <DropdownMenuItem
                    key={value}
                    className="flex flex-row items-center gap-x-2"
                    onClick={() => setTheme(value)}
                  >
                    <SolarIcon name={icon} className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {theme === value && <SolarIcon name="check" className="h-4 w-4 shrink-0" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut()}>
                  <SolarIcon name="logout" className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export function DashboardChrome({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const profile = useMyProfile();
  const router = useRouter();
  const base = useDashboardBase();

  useEffect(() => {
    if (!loading && !user) router.replace("/auth");
  }, [loading, user, router]);

  // No active workspace → the root resolver picks a workspace or onboarding.
  useEffect(() => {
    if (!loading && user && profile.isFetched && !profile.data?.organization_id) {
      router.replace("/dashboard");
    }
  }, [loading, user, profile.isFetched, profile.data?.organization_id, router]);

  if (loading || !user) {
    return <ConsoleLoading />;
  }

  return (
    // Follows the user's theme (next-themes): paper in light, charcoal in
    // dark — tokens come from the ASCII console scope (console.css).
    <div className="min-h-screen text-ink-muted">
      <SidebarProvider className="flex-col md:flex-row">
        {/* Mobile top bar — the sidebar itself becomes a drawer */}
        <header className="k-grain sticky top-0 z-20 flex h-12 items-center justify-between border-b border-hairline bg-canvas px-2 md:hidden">
          <Wordmark />
          <div className="flex items-center gap-1">
            <SpotlightButton />
            <SidebarTrigger className="h-8 w-8 text-ink-muted hover:text-ink" />
            <button
              type="button"
              onClick={() => signOut()}
              className="inline-flex h-8 w-8 items-center justify-center text-ink-muted hover:bg-pillar hover:text-ink"
              aria-label="Sign out"
            >
              <SolarIcon name="logout" className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* On large devices the main column scrolls here. On small devices
            the document is the only element that should scroll. */}
        <div className="relative flex min-h-svh w-full flex-col md:h-svh md:flex-row md:overflow-hidden">
          <ConsoleSidebar />

          <main className="relative flex min-w-0 flex-1 flex-col md:min-h-0 md:overflow-y-auto">
            <ConsoleTopbar />
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pt-8 pb-16 md:px-10 md:pt-10">
              {children}
            </div>
          </main>
        </div>
        <Spotlight basePath={base} />
      </SidebarProvider>
    </div>
  );
}

/** Desktop path bar — `keyring / acme / settings / api-keys` — plus ⌘K. */
function ConsoleTopbar() {
  const pathname = usePathname();
  const parts = pathname.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
  return (
    <div className="k-grain sticky top-0 z-10 hidden h-12 shrink-0 items-center justify-between gap-4 border-b border-hairline bg-canvas px-10 md:flex">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[12px]">
        <span className="k-dim">keyring</span>
        {parts.map((p, i) => (
          <span key={`${p}-${i}`} className="flex min-w-0 items-center gap-2">
            <span className="k-dim">/</span>
            <span className={cn("truncate", i === parts.length - 1 ? "text-ink" : "text-ink-muted")}>
              {p}
            </span>
          </span>
        ))}
      </nav>
      <button
        type="button"
        onClick={openSpotlight}
        className="flex shrink-0 items-center gap-2 text-[12px] text-ink-muted transition-colors hover:text-ink"
      >
        <span>search</span>
        <span className="k-kbd">⌘K</span>
      </button>
    </div>
  );
}

/** Hatched placeholder while the session / workspace resolves. */
export function ConsoleLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex w-full max-w-3xl animate-pulse flex-col gap-4 px-4" aria-hidden>
        <div className="h-7 w-48 rounded-sm bg-gray-100 dark:bg-polar-700" />
        <div className="h-4 w-72 max-w-full rounded-sm bg-gray-100 dark:bg-polar-700" />
        <div className="mt-2 h-40 w-full rounded-2xl bg-gray-100 dark:bg-polar-800" />
      </div>
    </div>
  );
}
