"use client"

import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
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
