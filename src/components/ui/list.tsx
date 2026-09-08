"use client";

import React, { PropsWithChildren } from "react";
import { twMerge } from "tailwind-merge";
import { Checkbox } from "./checkbox";

export interface ListProps extends PropsWithChildren {
  className?: string;
  size?: "small" | "default";
}

export const List = ({ children, className, size = "default" }: ListProps) => {
  return children ? (
    <div
      className={twMerge(
        "flex flex-col divide-y divide-hairline overflow-hidden border border-hairline dark:divide-polar-700 dark:border-polar-700",
        size === "default" ? "rounded-4xl" : "rounded-2xl",
        className,
      )}
    >
      {children}
    </div>
  ) : null;
};

export interface ListItemProps extends PropsWithChildren {
  className?: string;
  inactiveClassName?: string;
  selectedClassName?: string;
  children: React.ReactNode;
  selected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
  size?: "small" | "default";
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  checkboxVisible?: boolean;
  checkboxLabel?: string;
}

export const ListItem = ({
  className,
  inactiveClassName,
  selectedClassName,
  children,
  selected,
  onSelect,
  size = "default",
  checked,
  onCheckedChange,
  checkboxVisible,
  checkboxLabel = "Select item",
}: ListItemProps) => {
  const hasCheckbox = !!onCheckedChange;

  return (
    <div
      className={twMerge(
        "group/row flex flex-row items-center justify-between",
        selected ? "bg-gray-50 dark:bg-polar-800" : "hover:bg-gray-50 dark:hover:bg-polar-800",
        selected ? selectedClassName : inactiveClassName,
        onSelect && "cursor-pointer",
        size === "default" ? "py-4" : "py-2",
        hasCheckbox ? "pr-6" : size === "default" ? "px-6" : "px-4",
        !hasCheckbox && "gap-x-6",
        className,
      )}
      onClick={onSelect}
    >
      {onCheckedChange && (
        <div
          className={twMerge(
            "flex shrink-0 cursor-pointer items-center pl-4 pr-1",
            size === "default" ? "-my-4 py-4" : "-my-2 py-2",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCheckedChange(!checked);
          }}
        >
          <Checkbox
            aria-label={checkboxLabel}
            {...(checked !== undefined ? { checked } : {})}
            className={twMerge(
              "opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=checked]:opacity-100 data-[state=indeterminate]:opacity-100 pointer-coarse:opacity-100",
              checkboxVisible && "opacity-100",
            )}
          />
        </div>
      )}
      {children}
    </div>
  );
};
