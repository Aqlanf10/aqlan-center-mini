"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { StethoscopeIcon } from "lucide-react";

import { NAV_ITEMS } from "@/components/layout/nav-items";
import { Badge } from "@/components/ui/badge";
import type { SessionUser } from "@/lib/auth/guards";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/** Desktop sidebar — fixed, hidden below lg. Mobile uses MobileNav drawer. */
export function AppSidebar({ user }: { user: SessionUser }) {
  const { dict } = useI18n();
  const pathname = usePathname();

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <aside className="bg-sidebar text-sidebar-foreground fixed inset-y-0 start-0 z-40 hidden w-64 flex-col border-e lg:flex">
      {/* Brand */}
      <div className="flex items-center gap-3 border-b border-sidebar-border px-5 py-4">
        <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
          <StethoscopeIcon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{dict.app.name}</p>
          <p className="text-sidebar-foreground/70 truncate text-xs">
            {dict.app.tagline}
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav aria-label={dict.nav.mainNavigation} className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                "focus-visible:ring-sidebar-ring focus-visible:ring-2 focus-visible:outline-none",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "bg-sidebar-primary absolute inset-y-2 start-0 w-1 rounded-full transition-opacity",
                  active ? "opacity-100" : "opacity-0"
                )}
              />
              <Icon className="size-4.5 shrink-0" aria-hidden="true" />
              {dict.nav[item.labelKey]}
            </Link>
          );
        })}
      </nav>

      {/* Signed-in user summary */}
      <div className="border-t border-sidebar-border px-5 py-4">
        <p className="text-xs leading-relaxed text-sidebar-foreground/60">
          {dict.auth.signedInAs}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="truncate text-sm font-semibold">{user.name}</p>
          <Badge
            variant="outline"
            className="border-sidebar-border bg-transparent text-sidebar-foreground/90 shrink-0"
          >
            {dict.roles[user.role]}
          </Badge>
        </div>
      </div>
    </aside>
  );
}
