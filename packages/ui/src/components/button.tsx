import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@keyring/ui/lib/utils";

const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-[0.01em] cursor-pointer select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "rounded-full bg-ink text-canvas hover:opacity-85 transition-opacity duration-100",
        destructive:
          "rounded-full bg-red-500 dark:bg-red-600 text-white hover:bg-red-400 dark:hover:bg-red-500",
        outline:
          "rounded-full border border-surface-1 bg-transparent text-ink-navy hover:bg-pillar dark:border-polar-700 dark:text-white dark:hover:bg-polar-700",
        secondary:
          "rounded-full border border-black/5 bg-pillar text-ink-navy hover:bg-surface-1/60 dark:border-white/5 dark:bg-polar-700 dark:text-white dark:hover:bg-polar-600",
        ghost:
          "rounded-full bg-transparent text-ink-navy hover:bg-pillar dark:text-white dark:hover:bg-polar-700",
        link: "text-blue-600 dark:text-blue-400 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-5 py-3 text-sm",
        sm: "h-8 px-3 py-1.5 text-xs",
        lg: "h-12 px-5 py-4 text-sm",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);


export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
