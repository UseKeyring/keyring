import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";

import { cn } from "@keyring/ui/lib/utils";
import { SolarIcon } from "@keyring/ui/components/solar-icon";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "group grid place-content-center peer h-4 w-4 shrink-0 rounded-[4px] border border-ink-navy/40 bg-transparent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:border-polar-500 data-[state=checked]:bg-ink data-[state=checked]:border-ink data-[state=checked]:text-canvas data-[state=indeterminate]:bg-ink data-[state=indeterminate]:border-ink data-[state=indeterminate]:text-canvas",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("grid place-content-center text-current")}>
      <SolarIcon
        name="checkPlain"
        className="h-4 w-4 group-data-[state=indeterminate]/hidden"
      />
      <span className="hidden h-0.5 w-2.5 rounded-full bg-current group-data-[state=indeterminate]:block" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
