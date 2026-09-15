"use client";

import { useMemo, type MouseEvent, type ReactNode } from "react";
import { Button } from "@keyring/ui/components/button";
import { Checkbox } from "@keyring/ui/components/checkbox";
import { Label } from "@keyring/ui/components/label";
import { cn } from "@keyring/ui/lib/utils";

interface OptionGroup<T extends string> {
  key: string;
  label: string;
  options: T[];
}

const UNGROUPED_KEY = "__ungrouped__";

const humanize = (value: string): string =>
  value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const buildGroups = <T extends string>(
  options: readonly T[],
  separator: string,
): OptionGroup<T>[] => {
  const groupsByKey = new Map<string, OptionGroup<T>>();

  for (const option of options) {
    const separatorIndex = option.indexOf(separator);
    const key = separatorIndex === -1 ? UNGROUPED_KEY : option.slice(0, separatorIndex);

    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        key,
        label: key === UNGROUPED_KEY ? "General" : humanize(key),
        options: [],
      };
      groupsByKey.set(key, group);
    }
    group.options.push(option);
  }

  return Array.from(groupsByKey.values())
    .map((group) => ({
      ...group,
      options: [...group.options].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      if (a.key === UNGROUPED_KEY) return -1;
      if (b.key === UNGROUPED_KEY) return 1;
      return a.label.localeCompare(b.label);
    });
};

export interface TreeMultiSelectProps<T extends string> {
  options: readonly T[];
  value: T[];
  onChange: (next: T[]) => void;
  title?: ReactNode;
  separator?: string;
  /** Options the user cannot toggle (still shown if present in `options`). */
  disabledOptions?: readonly T[];
  renderOptionSuffix?: (option: T) => ReactNode;
  className?: string;
}

export function TreeMultiSelect<T extends string>({
  options,
  value,
  onChange,
  title,
  separator = ".",
  disabledOptions,
  renderOptionSuffix,
  className,
}: TreeMultiSelectProps<T>) {
  const groups = useMemo(() => buildGroups(options, separator), [options, separator]);
  const selected = useMemo(() => new Set(value), [value]);
  const disabled = useMemo(
    () => new Set(disabledOptions ?? []),
    [disabledOptions],
  );

  const selectable = options.filter((o) => !disabled.has(o));
  const allSelected =
    selectable.length > 0 && selectable.every((o) => selected.has(o));

  const setOptions = (next: Iterable<T>) => onChange(Array.from(next));

  const onToggleAll = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (allSelected) {
      setOptions(value.filter((o) => disabled.has(o) && selected.has(o)));
      return;
    }
    const next = new Set(value);
    for (const o of selectable) next.add(o);
    setOptions(next);
  };

  const onToggleOption = (option: T) => {
    if (disabled.has(option)) return;
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    setOptions(next);
  };

  const onToggleGroup = (group: OptionGroup<T>) => {
    const groupSelectable = group.options.filter((o) => !disabled.has(o));
    if (groupSelectable.length === 0) return;
    const next = new Set(selected);
    const fullySelected = groupSelectable.every((o) => next.has(o));
    for (const option of groupSelectable) {
      if (fullySelected) next.delete(option);
      else next.add(option);
    }
    setOptions(next);
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-3">
        {title ? (
          <span className="type-body-sm font-medium text-ink">{title}</span>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onToggleAll}
          disabled={selectable.length === 0}
        >
          {allSelected ? "Unselect all" : "Select all"}
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        {groups.map((group) => {
          const groupSelectable = group.options.filter((o) => !disabled.has(o));
          const selectedCount = groupSelectable.filter((o) => selected.has(o)).length;
          const groupChecked: boolean | "indeterminate" =
            selectedCount === 0
              ? false
              : selectedCount === groupSelectable.length
                ? true
                : "indeterminate";

          return (
            <div key={group.key} className="flex flex-col">
              <Label className="flex cursor-pointer items-center gap-2 py-1.5 font-normal">
                <Checkbox
                  checked={groupChecked}
                  disabled={groupSelectable.length === 0}
                  onCheckedChange={() => onToggleGroup(group)}
                />
                <span className="type-mono text-sm text-ink">{group.label}</span>
              </Label>

              <div className="flex flex-col pl-6">
                {group.options.map((option) => (
                  <Label
                    key={option}
                    className={cn(
                      "flex items-center gap-2 py-1.5 font-normal",
                      disabled.has(option)
                        ? "cursor-not-allowed opacity-60"
                        : "cursor-pointer",
                    )}
                  >
                    <Checkbox
                      checked={selected.has(option)}
                      disabled={disabled.has(option)}
                      onCheckedChange={() => onToggleOption(option)}
                    />
                    <span className="type-mono text-sm text-ink">{option}</span>
                    {renderOptionSuffix?.(option)}
                  </Label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
