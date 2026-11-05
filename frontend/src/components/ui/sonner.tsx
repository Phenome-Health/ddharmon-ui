"use client"

import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      // CLEAR OF THE CONTINUE BAR (review round 6): the pinned bar fills the bottom 84px of every gate screen and
      // its primary action sits at the right, where toasts stack — a toast over "Start run" swallowed the click. 104 =
      // the bar's 84 + the 16px rhythm. Pages without the bar just float their toasts a little higher.
      offset={{ bottom: 104, right: 32 }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-surface-raised group-[.toaster]:text-on-raised group-[.toaster]:border-rule-on-raised group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-on-raised-muted",
          actionButton:
            "group-[.toast]:bg-accent-action group-[.toast]:text-on-accent-action",
          cancelButton:
            "group-[.toast]:bg-surface-inset-strong group-[.toast]:text-on-inset-strong-muted",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
