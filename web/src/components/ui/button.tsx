// Based on shadcn/ui Button component (MIT License: https://github.com/shadcn-ui/ui)
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded text-sm font-medium transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary-action text-primary-action-fg border border-primary-action hover:opacity-90",
        outline:
          "border border-border-strong bg-surface text-text hover:bg-surface-subtle",
        ghost: "text-text-muted hover:bg-surface-subtle hover:text-text",
        destructive:
          "border border-negative bg-negative-bg text-negative hover:opacity-90",
      },
      size: {
        default: "h-9 px-3.5 py-2",
        sm: "h-7 px-2.5 text-xs",
        lg: "h-10 px-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
