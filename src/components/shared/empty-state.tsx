import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Optional extra content rendered under the description (e.g. tags). */
  children?: React.ReactNode;
  className?: string;
};

/** Shared empty state — used instead of any fake data. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "bg-muted/50 flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center sm:p-12",
        className
      )}
    >
      {Icon ? (
        <span className="bg-background text-muted-foreground flex size-12 items-center justify-center rounded-full border shadow-sm">
          <Icon className="size-6" aria-hidden="true" />
        </span>
      ) : null}
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold">{title}</h3>
        {description ? (
          <p className="text-muted-foreground mx-auto max-w-md text-sm leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
