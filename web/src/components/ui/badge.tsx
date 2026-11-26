// Based on shadcn/ui Badge component (MIT License: https://github.com/shadcn-ui/ui)
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-border-strong bg-surface-subtle text-text",
        positive: "border-positive/30 bg-positive-bg text-positive",
        negative: "border-negative/30 bg-negative-bg text-negative",
        warning: "border-warning/30 bg-warning-bg text-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
