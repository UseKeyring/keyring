import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@keyring/ui/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-1 text-xs font-normal transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-ink text-canvas hover:bg-ink/85",
        secondary:
          "border-hairline bg-pillar text-ink-navy hover:bg-surface-1/40",
        destructive:
          "border-accent-orange bg-transparent text-accent-orange hover:bg-pillar",
        outline: "text-ink-navy border-hairline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
