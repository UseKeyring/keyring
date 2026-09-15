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
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@keyring/ui/components/sidebar";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import { Spotlight, SpotlightButton } from "./spotlight";
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
          { to: `${base}/members`, label: "Members", icon: "members", read: "members.read" },
          { to: `${base}/users`, label: "Users", icon: "users", read: "users.read" },
        ],
      },
      {
        label: "System",
        items: [
          { to: `${base}/audit`, label: "Activity", icon: "activity", read: "audit.read" },
          { to: `${base}/settings`, label: "Settings", icon: "settings" },
        ],
      },
    ],
  };
}

function NavItem({ item }: { item: NavEntry }) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch workspace"
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-pillar"
        >
          <Avatar
            name={active?.organizations?.name ?? "?"}
            avatar_url={active?.organizations?.avatar_url ?? null}
            className="h-6 w-6"
          />
          <span className="type-label min-w-0 flex-1 truncate text-[15px] text-ink">
            {active?.organizations?.name ?? "Workspaces"}
          </span>
          <SolarIcon name="chevronDown" className="h-4 w-4 shrink-0 text-ink-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="w-(--radix-popper-anchor-width) min-w-[220px]"
      >
        <DropdownMenuLabel>
          <span className="type-mono block text-ink-muted">Workspaces</span>
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
    accessLoading ? items : items.filter((i) => !i.read || can(i.read));

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="flex flex-row items-center justify-between gap-2 md:pt-3.5 group-data-[collapsible=icon]:justify-center">
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <WorkspaceSwitcher />
        </div>
        <div className="flex shrink-0 flex-row items-center gap-1 group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:justify-center">
          <SidebarTrigger />
          <div className="group-data-[collapsible=icon]:hidden">
            <SpotlightButton />
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-0 py-2">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem item={overview} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {sections.map((section) => {
          const items = visible(section.items);
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={section.label}>
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
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

      <SidebarFooter>
        <SidebarSeparator />
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
                  <span className="type-body-sm block truncate text-ink">{user?.email}</span>
                  <span className="type-mono block text-ink-muted">{roleLabel}</span>
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
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <div className="flex w-full max-w-3xl animate-pulse flex-col gap-4 px-4" aria-hidden>
          <div className="h-7 w-48 rounded-sm bg-gray-100 dark:bg-polar-700" />
          <div className="h-4 w-72 max-w-full rounded-sm bg-gray-100 dark:bg-polar-700" />
          <div className="mt-2 h-40 w-full rounded-2xl bg-gray-100 dark:bg-polar-800" />
        </div>
      </div>
    );
  }

  return (
    // The console follows the user's theme (next-themes) like the rest of
    // the app — light canvas in light mode, Polar dark dashboard in dark.
    <div className="min-h-screen bg-canvas text-ink-muted">
      <SidebarProvider>
        {/* Mobile top bar — the sidebar itself becomes a drawer */}
        <header className="sticky top-0 z-20 flex items-center justify-between bg-canvas px-4 py-2 md:hidden">
          <Wordmark />
          <div className="flex items-center gap-1">
            <SpotlightButton />
            <SidebarTrigger />
            <button
              type="button"
              onClick={() => signOut()}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-muted hover:bg-pillar hover:text-ink"
              aria-label="Sign out"
            >
              <SolarIcon name="logout" className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* On large devices the card scrolls here. On small devices the
            document is the only element that should scroll. */}
        <div className="relative flex min-h-svh w-full flex-col md:h-svh md:flex-row md:overflow-hidden md:p-2">
          <ConsoleSidebar />

          {/* Main — inset rounded card */}
          <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl border border-hairline bg-white shadow-xs md:min-h-0 md:overflow-y-auto dark:border-polar-800 dark:bg-polar-900">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pt-8 pb-8 md:px-8">
              {children}
            </div>
          </main>
        </div>
        <Spotlight basePath={base} />
      </SidebarProvider>
    </div>
  );
}
