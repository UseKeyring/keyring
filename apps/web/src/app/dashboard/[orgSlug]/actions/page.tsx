"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAction, isCustomerPermission, useMyAccess, usePermissions, type Permission } from "@/hooks/useRbac";
import { Button } from "@keyring/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@keyring/ui/components/dialog";
import { Input } from "@keyring/ui/components/input";
import { List, ListItem } from "@keyring/ui/components/list";
import { NoAccess } from "@keyring/ui/components/no-access";
import { ListSkeleton } from "@keyring/ui/components/skeletons";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import { Tabs, TabsList, TabsTrigger } from "@keyring/ui/components/tabs";
import { useDashboardBase } from "../../dashboard-chrome";

export default function ActionsPage() {
  const perms = usePermissions();
  const { can, loading: accessLoading } = useMyAccess();
  const { user } = useAuth();
  const qc = useQueryClient();
  const base = useDashboardBase();
  const editable = can("permissions.manage");

  const [query, setQuery] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const remove = async (id: string, s: string) => {
    const { error } = await getSupabaseBrowserClient().from("permissions").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "action.deleted", s);
    qc.invalidateQueries({ queryKey: ["permissions"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
    toast.success("Action deleted");
  };

  const grouped = (perms.data ?? [])
    .filter(isCustomerPermission)
    .reduce<Record<string, Permission[]>>((acc, p) => {
      (acc[p.category] ||= []).push(p);
      return acc;
    }, {});

  const categories = ["All", ...Object.keys(grouped)];
  const q = query.trim().toLowerCase();
  const visibleGroups = Object.entries(grouped)
    .filter(([cat]) => catFilter === "All" || cat === catFilter)
    .map(
      ([cat, items]) =>
        [
          cat,
          (items ?? []).filter(
            (p) =>
              !q ||
              p.slug.toLowerCase().includes(q) ||
              p.name.toLowerCase().includes(q) ||
              (p.description ?? "").toLowerCase().includes(q),
          ),
        ] as const,
    )
    .filter(([, items]) => items.length > 0);

  if (!accessLoading && !can("permissions.read")) {
    return <NoAccess title="Actions" action="permissions.read" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Actions</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            The atomic things a user can do. Roles are built out of these.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={() => setFiltersOpen(true)}
            variant="secondary"
            size="sm"
            aria-label="Customize"
          >
            <SolarIcon name="customize" className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Customize</span>
          </Button>
          {editable && (
            <Button size="sm" asChild>
              <Link href={`${base}/actions/new`}>
                <SolarIcon name="plus" className="h-3.5 w-3.5" />
                <span className="hidden md:inline">New Action</span>
              </Link>
            </Button>
          )}
        </div>
      </div>

      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent className="top-20 left-1/2 w-full max-w-[800px] translate-x-[-50%] translate-y-0 gap-0 rounded-3xl border border-hairline bg-white p-1 shadow-sm sm:rounded-3xl dark:border-polar-800 dark:bg-polar-950 [&>button]:hidden">
          <DialogTitle className="sr-only">Filter actions</DialogTitle>
          <div className="flex flex-row items-center justify-between pt-1 pr-1 pb-0 pl-4 text-sm">
            <span className="type-body-sm text-ink-muted">Filter actions</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 rounded-full text-ink-muted hover:text-ink"
              onClick={() => setFiltersOpen(false)}
              aria-label="Close filters"
            >
              <SolarIcon name="close" className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-col gap-4 overflow-y-auto rounded-[20px] bg-pillar p-6 dark:bg-polar-900">
            <div className="relative">
              <SolarIcon name="search" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-muted" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search actions"
                className="pl-10"
              />
            </div>
            <Tabs value={catFilter} onValueChange={setCatFilter}>
              <TabsList>
                {categories.map((c) => (
                  <TabsTrigger key={c} value={c} size="small">
                    {c}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="flex items-center justify-between">
              <span className="type-mono text-ink-muted">
                {visibleGroups.reduce((n, [, items]) => n + items.length, 0)} shown
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setCatFilter("All");
                }}
              >
                Clear
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="space-y-6">
        {perms.isLoading ? (
          <ListSkeleton />
        ) : (
        <>
        {visibleGroups.map(([cat, items]) => (
          <div key={cat}>
            <div className="type-eyebrow px-2 pb-2 text-ink-muted">{cat}</div>
            <List size="small">
              {(items ?? []).map((p) => (
                <ListItem
                  key={p.id}
                  size="small"
                  className="flex flex-row items-center justify-between gap-x-6 pr-3"
                >
                  <div className="flex min-w-0 grow flex-row items-center gap-x-4">
                    <div className="min-w-0">
                      <div className="type-body-sm truncate text-ink">{p.slug}</div>
                      <div className="type-mono truncate text-ink-muted">
                        {p.name}
                        {p.description ? ` — ${p.description}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-row items-center gap-x-4">
                    {p.is_system && (
                      <span className="type-eyebrow rounded-full border border-hairline px-2.5 py-1 text-[10px] text-ink-muted">
                        System
                      </span>
                    )}
                    {editable && !p.is_system && (
                      <Button variant="destructive" size="sm" onClick={() => remove(p.id, p.slug)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </ListItem>
              ))}
            </List>
          </div>
        ))}
        {visibleGroups.length === 0 && (
          <div className="type-body-sm py-12 text-center text-ink-muted">
            No actions match.
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}
