import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-xs font-semibold border whitespace-nowrap transition-colors focus:outline-none focus:ring-2 focus:ring-focus-ring-on-raised focus:ring-offset-2",
  {
    variants: {
      variant: {
        // Tone-based variants
        neutral: "bg-surface-inset-strong text-on-inset-strong border-rule-on-raised",
        success: "bg-success-bg text-success border-success-border",
        warning: "bg-warning-bg text-warning border-warning-border",
        danger: "bg-danger-bg text-danger border-danger-border",
        info: "bg-info-bg text-info border-info-border",
        brand: "bg-surface-inset-strong text-accent-on-inset-strong border-rule-on-raised",
        // Backward-compatibility aliases
        outline: "bg-surface-inset-strong text-on-inset-strong border-rule-on-raised",
        secondary: "bg-surface-inset-strong text-on-inset-strong border-rule-on-raised",
        destructive: "bg-danger-bg text-danger border-danger-border",
        default: "bg-surface-inset-strong text-accent-on-inset-strong border-rule-on-raised",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
