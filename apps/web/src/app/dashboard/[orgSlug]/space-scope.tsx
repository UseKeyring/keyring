"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSpaces } from "@/hooks/useRbac";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@keyring/ui/components/select";

/**
 * Selected RBAC scope, carried in the URL (`?space=<slug>`, absent = platform
 * scope). Shared by Actions / Roles / Users so each surface manages exactly
 * one scope: platform level or one fully-isolated space.
 */
export function useSpaceScope() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const spaces = useSpaces();

  const raw = params.get("space")?.trim() || null;
  const match = (spaces.data ?? []).find((s) => s.slug === raw) ?? null;
  // Unknown slug in the URL falls back to the platform scope (fail-closed
  // rendering: no space rows shown rather than the wrong space's rows).
  const spaceSlug = match ? match.slug : null;
  const spaceId = match ? match.id : null;

  const setSpaceSlug = (slug: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (slug) next.set("space", slug);
    else next.delete("space");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return { spaceSlug, spaceId, spaces, setSpaceSlug };
}

/** Platform + space picker for the manage surfaces. */
export function SpaceScopeSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (slug: string | null) => void;
}) {
  const spaces = useSpaces();
  return (
    <Select value={value ?? "platform"} onValueChange={(v) => onChange(v === "platform" ? null : v)}>
      <SelectTrigger className="w-full md:w-[220px]">
        <SelectValue placeholder="Platform" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="platform">Platform (no space)</SelectItem>
        {(spaces.data ?? []).map((s) => (
          <SelectItem key={s.id} value={s.slug}>
            {s.name} ({s.slug})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
