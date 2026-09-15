import * as React from "react";

import { cn } from "@keyring/ui/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-xl border border-hairline bg-canvas px-3 py-2 text-base text-ink-navy shadow-xs outline-none transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ink-subtle focus-visible:outline-none focus-visible:border-blue-600 focus-visible:ring-[3px] focus-visible:ring-blue-600/20 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:border-polar-700 dark:bg-polar-800 dark:text-white dark:placeholder:text-polar-500 dark:focus-visible:border-blue-600 dark:focus-visible:ring-blue-600/40",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
