"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMyAccess } from "@/hooks/useRbac";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@keyring/ui/components/command";
import { SolarIcon, type SolarName } from "@keyring/ui/components/solar-icon";

export const SPOTLIGHT_EVENT = "keyring:open-spotlight";

export function openSpotlight() {
  window.dispatchEvent(new CustomEvent(SPOTLIGHT_EVENT));
}

export function SpotlightButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openSpotlight}
      aria-label="Search"
      className={twMerge(
        "inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-pillar hover:text-ink",
        className,
      )}
    >
      <SolarIcon name="search" className="h-4 w-4" />
    </button>
  );
}

type RouteEntry = {
  id: string;
  title: string;
  /** Workspace-relative suffix ("" = overview) or absolute path. */
  suffix: string;
  absolute?: boolean;
  icon: SolarName;
  keywords: string;
  /** Read action required to surface this shortcut; omitted = members. */
  read?: string;
};

const ROUTES: RouteEntry[] = [
  { id: "overview", title: "Overview", suffix: "", icon: "overview", keywords: "home stats" },
  {
    id: "actions",
    title: "Actions",
    suffix: "/actions",
    icon: "actions",
    keywords: "permissions slugs policy",
    read: "permissions.read",
  },
  {
    id: "roles",
    title: "Roles",
    suffix: "/roles",
    icon: "roles",
    keywords: "bundles groups grants",
    read: "roles.read",
  },
  {
    id: "members",
    title: "Members",
    suffix: "/members",
    icon: "members",
    keywords: "team managers grants",
    read: "members.read",
  },
  {
    id: "users",
    title: "Users",
    suffix: "/users",
    icon: "users",
    keywords: "directory subjects accounts",
    read: "users.read",
  },
  {
    id: "activity",
    title: "Activity",
    suffix: "/audit",
    icon: "activity",
    keywords: "audit log history",
    read: "audit.read",
  },
  {
    id: "workspace-settings",
    title: "Workspace settings",
    suffix: "/settings",
    icon: "settings",
    keywords: "organization workspace api keys",
  },
  {
    id: "account-settings",
    title: "Account settings",
    suffix: "/dashboard/account",
    absolute: true,
    icon: "settings",
    keywords: "profile preferences email password theme account",
  },
];

// Manage action required for command-style shortcuts, by action id.
const ACTION_REQUIRES: Record<string, string> = {
  "create-action": "permissions.manage",
  "create-role": "roles.manage",
  "invite-member": "users.manage",
};

type SearchResult =
  | { type: "action"; id: string; title: string; url: string; icon: SolarName }
  | { type: "page"; id: string; title: string; url: string; icon: SolarName }
  | { type: "role"; id: string; title: string; description: string | null }
  | { type: "permission"; id: string; title: string; description: string | null }
  | { type: "member"; id: string; title: string; description: string | null };

function Result({
  icon,
  title,
  description,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string | null | undefined;
}) {
  return (
    <div className="flex w-full flex-row items-center justify-between gap-3 px-2">
      <div className="flex w-full flex-col gap-0.5">
        <div className="flex flex-row items-center gap-2">
          {icon && (
            <span className="flex h-5 w-5 items-center justify-center text-ink-muted">{icon}</span>
          )}
          <div className="font-medium text-ink">{title}</div>
        </div>
        {description && <div className="text-sm text-ink-muted">{description}</div>}
      </div>
      <div className="-mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-pillar px-1.5 py-0.5 opacity-0 group-data-[selected='true']:opacity-100 dark:bg-polar-800">
        <SolarIcon name="reply" className="h-3 w-3 text-ink-muted" />
      </div>
    </div>
  );
}

export function Spotlight({ basePath }: { basePath: string }) {
  const router = useRouter();
  const { signOut } = useAuth();
  const { can, loading: accessLoading } = useMyAccess();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SPOTLIGHT_EVENT, onEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SPOTLIGHT_EVENT, onEvent);
    };
  }, []);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const actionResults = useMemo(() => {
    const actions: SearchResult[] = [
      {
        type: "action",
        id: "create-action",
        title: "Create action",
        url: `${basePath}/actions/new`,
        icon: "actions",
      },
      {
        type: "action",
        id: "create-role",
        title: "Create role",
        url: `${basePath}/roles/new`,
        icon: "roles",
      },
      {
        type: "action",
        id: "invite-member",
        title: "Invite member",
        url: `${basePath}/members`,
        icon: "members",
      },
      { type: "action", id: "sign-out", title: "Sign out", url: "", icon: "logout" },
    ];
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return actions
      .filter((a) => {
        if (!a.title.toLowerCase().includes(q)) return false;
        const required = ACTION_REQUIRES[a.id];
        return !required || accessLoading || can(required);
      })
      .slice(0, 3);
  }, [query, accessLoading, can, basePath]);

  const pageResults = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return ROUTES.filter(
      (r) =>
        (r.title.toLowerCase().includes(q) || r.keywords.includes(q)) &&
        (!r.read || accessLoading || can(r.read)),
    )
      .map((r): SearchResult => ({
        type: "page",
        id: r.id,
        title: r.title,
        url: r.absolute ? r.suffix : `${basePath}${r.suffix}`,
        icon: r.icon,
      }))
      .slice(0, 5);
  }, [query, accessLoading, can, basePath]);

  const requestRef = useRef(0);

  const performSearch = useCallback(async (searchQuery: string) => {
    const requestId = ++requestRef.current;
    const isCurrent = () => requestRef.current === requestId;
    if (!searchQuery.trim()) {
      if (!isCurrent()) return;
      setResults([]);
      setHasSearched(false);
      return;
    }

    const loadingTimer = setTimeout(() => {
      if (isCurrent()) setLoading(true);
    }, 150);
    try {
      const supabase = getSupabaseBrowserClient();
      const q = `%${searchQuery.trim()}%`;

      const [roles, perms, profiles] = await Promise.all([
        supabase
          .from("roles")
          .select("id,slug,name,scope")
          .or(`slug.ilike.${q},name.ilike.${q}`)
          .eq("scope", "customer")
          .limit(5),
        supabase
          .from("permissions")
          .select("id,slug,name,scope")
          .or(`slug.ilike.${q},name.ilike.${q}`)
          .eq("scope", "customer")
          .limit(5),
        supabase
          .from("profiles")
          .select("id,email,full_name")
          .or(`email.ilike.${q},full_name.ilike.${q}`)
          .limit(5),
      ]);

      if (!isCurrent()) return;

      const out: SearchResult[] = [
        ...(roles.data ?? []).map((r): SearchResult => ({
          type: "role",
          id: r.id,
          title: r.name,
          description: r.slug,
        })),
        ...(perms.data ?? []).map((p): SearchResult => ({
          type: "permission",
          id: p.id,
          title: p.slug,
          description: p.name,
        })),
        ...(profiles.data ?? []).map((p): SearchResult => ({
          type: "member",
          id: p.id,
          title: p.full_name || p.email,
          description: p.full_name ? p.email : null,
        })),
      ];
      setResults(out);
      setHasSearched(true);
    } catch (error) {
      if (!isCurrent()) return;
      console.error("Search error:", error);
      setResults([]);
      setHasSearched(true);
    } finally {
      clearTimeout(loadingTimer);
      if (isCurrent()) setLoading(false);
    }
  }, []);

  const combinedResults = useMemo(
    () => [...actionResults, ...pageResults, ...results],
    [actionResults, pageResults, results],
  );

  useEffect(() => {
    const debounce = setTimeout(() => {
      performSearch(query);
    }, 400);

    return () => {
      clearTimeout(debounce);
    };
  }, [query, performSearch]);

  const handleSelect = (result: SearchResult) => {
    let path: string = "";
    switch (result.type) {
      case "action":
        if (result.id === "sign-out") {
          void signOut();
          setOpen(false);
          setQuery("");
          return;
        }
        path = result.url;
        break;
      case "page":
        path = result.url;
        break;
      case "role":
        path = `${basePath}/roles`;
        break;
      case "permission":
        path = `${basePath}/actions`;
        break;
      case "member":
        path = `${basePath}/members`;
        break;
    }

    if (path) {
      router.push(path);
      setOpen(false);
      setQuery("");
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case "action":
        return "Quick Action";
      case "page":
        return "Go to";
      case "role":
        return "Roles";
      case "permission":
        return "Actions";
      case "member":
        return "Members";
      default:
        return type;
    }
  };

  const groupedResults: Record<string, SearchResult[]> = useMemo(
    () =>
      combinedResults.reduce(
        (acc, result) => {
          const bucket = acc[result.type];
          if (bucket) bucket.push(result);
          else acc[result.type] = [result];
          return acc;
        },
        {} as Record<string, SearchResult[]>,
      ),
    [combinedResults],
  );

  const renderResult = (result: SearchResult) => {
    switch (result.type) {
      case "action":
        return (
          <Result
            icon={<SolarIcon name={result.icon} className="h-4 w-4" />}
            title={result.title}
          />
        );
      case "page":
        return (
          <Result
            icon={<SolarIcon name={result.icon} className="h-4 w-4" />}
            title={result.title}
          />
        );
      case "role":
      case "permission":
        return <Result title={result.title} description={result.description || undefined} />;
      case "member":
        return <Result title={result.title} description={result.description || undefined} />;
    }
  };

  const cleanState = !query || (!loading && !hasSearched && combinedResults.length === 0);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-bottom-4 data-[state=open]:slide-in-from-bottom-4 fixed top-[15%] left-[50%] z-50 w-full max-w-2xl translate-x-[-50%] overflow-hidden rounded-xl border border-hairline bg-white p-0 shadow-2xl dark:border-polar-800/80 dark:bg-polar-950">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <Command
            className="[&_[cmdk-group-heading]]:text-xxs rounded-xl border-none [&_[cmdk-group-heading]]:px-0 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-muted [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group]]:px-3 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-14 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
            shouldFilter={false}
          >
            <div className="flex grow items-center px-4">
              <CommandInput
                placeholder="Search actions, roles, members..."
                value={query}
                onValueChange={setQuery}
                wrapperClassName="border-none grow gap-3"
                className="flex w-full grow border-0 text-base text-ink placeholder:text-ink-muted focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>

            <CommandList
              className={twMerge(
                "max-h-[420px] overflow-y-auto border-t border-hairline px-0 pt-2 pb-3",
                cleanState ? "hidden" : "",
              )}
            >
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-ink-muted" />
                </div>
              ) : !loading && hasSearched && query && combinedResults.length === 0 ? (
                <div className="py-12 text-center text-sm text-ink-muted">
                  No results found for &ldquo;{query}&rdquo;
                </div>
              ) : (
                <>
                  {Object.entries(groupedResults).map(([type, typeResults], index) => {
                    const isLastGroup = index === Object.entries(groupedResults).length - 1;
                    return (
                      <CommandGroup
                        key={type}
                        heading={getTypeLabel(type)}
                        className={twMerge("p-0", isLastGroup ? "mb-0" : "mb-2")}
                      >
                        {typeResults.map((result, resultIndex) => {
                          const key = `${result.type}-${result.id}`;
                          const isFirst = index === 0 && resultIndex === 0;
                          const isLastItem = isLastGroup && resultIndex === typeResults.length - 1;
                          return (
                            <CommandItem
                              key={key}
                              value={key}
                              onSelect={() => handleSelect(result)}
                              className={twMerge(
                                "group cursor-pointer rounded-xl px-3 py-3 text-ink data-[selected=true]:bg-pillar data-[selected=true]:text-inherit dark:data-[selected=true]:bg-polar-800",
                                isFirst ? "scroll-mt-12" : "",
                                isLastItem
                                  ? "mb-3 scroll-mb-12"
                                  : resultIndex < typeResults.length - 1
                                    ? "mb-1"
                                    : "",
                              )}
                            >
                              {renderResult(result)}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    );
                  })}
                </>
              )}
            </CommandList>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
