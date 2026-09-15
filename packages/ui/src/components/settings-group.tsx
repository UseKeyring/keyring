import type { ReactNode } from "react";
import { cn } from "@keyring/ui/lib/utils";

export function SettingsGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col divide-y divide-hairline overflow-hidden rounded-2xl bg-transparent ring-1 ring-hairline dark:divide-polar-700 dark:bg-polar-900 dark:ring-polar-700",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsGroupItem({
  title,
  description,
  children,
  layout = "split",
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  layout?: "split" | "stacked";
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 p-4",
        layout === "split" && "md:flex-row md:items-start md:justify-between md:gap-12",
      )}
    >
      <div className="flex w-full flex-col md:max-w-[50%]">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {description && <p className="text-xs text-ink-muted">{description}</p>}
      </div>
      {children && <div className="w-full md:flex md:justify-end">{children}</div>}
    </div>
  );
}
