import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // 08-30b (controls lab round 1): 18px, 5px radius, 1.5px border, a 12px heavy tick — roomier than the
      // 16px default, and the same box everywhere a reviewer ticks something. Indeterminate wears a minus.
      "grid place-content-center peer h-[18px] w-[18px] shrink-0 rounded-[5px] border-[1.5px] border-rule-control-on-raised bg-surface-raised transition-colors enabled:hover:border-accent-action focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring-on-raised disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent-action data-[state=checked]:border-accent-action data-[state=checked]:text-on-accent-action data-[state=indeterminate]:bg-accent-action data-[state=indeterminate]:border-accent-action data-[state=indeterminate]:text-on-accent-action",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("grid place-content-center text-current")}
    >
      {props.checked === "indeterminate" ? (
        <Minus className="h-3 w-3" strokeWidth={3} />
      ) : (
        <Check className="h-3 w-3" strokeWidth={3} />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
