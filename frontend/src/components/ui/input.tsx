import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded border border-rule-control-on-raised bg-surface-raised px-3 py-2 text-sm text-on-raised transition-colors file:border-0 file:bg-transparent file:text-sm file:font-semibold file:text-card-foreground placeholder:text-on-raised-muted focus-visible:outline-none focus-visible:border-focus-ring-on-raised focus-visible:ring-1 focus-visible:ring-focus-ring-on-raised disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-on-raised-muted",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
