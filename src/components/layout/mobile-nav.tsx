"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MenuIcon } from "lucide-react";
import Image from "next/image";

import {
  NAV_SECTIONS,
  groupNavItems,
  isNavItemActive,
  navLabel,
  visibleNavItems,
} from "@/components/layout/nav-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { SessionUser } from "@/lib/auth/guards";
import { getDirection } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/** Mobile navigation drawer — touch friendly, opens from the start edge. */
export function MobileNav({
  user,
  brandName,
}: {
  user: SessionUser;
  brandName: string;
}) {
  const { dict, locale } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const side = getDirection(locale) === "rtl" ? "right" : "left";

  const visibleItems = visibleNavItems(user.role);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={dict.common.openMenu}
        >
          <MenuIcon className="size-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side={side} className="bg-sidebar text-sidebar-foreground w-72 gap-0 p-0">
        <SheetHeader className="border-b border-sidebar-border px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white p-1">
              <Image
                src="/logo-icon.png"
                alt={brandName}
                width={34}
                height={34}
                className="size-full object-contain"
              />
            </span>
            <div className="min-w-0">
              <SheetTitle className="text-sidebar-foreground truncate text-sm font-bold">
                {brandName}
              </SheetTitle>
              <SheetDescription className="text-sidebar-foreground/70 truncate text-xs">
                {dict.app.tagline}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <nav
          aria-label={dict.nav.mainNavigation}
          className="flex-1 space-y-1 overflow-y-auto px-3 py-4"
        >
          {groupNavItems(visibleItems).map((group) => (
            <div key={group.section ?? "main"} className="space-y-1">
              {group.section ? (
                <p className="text-sidebar-foreground/50 px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide">
                  {dict.nav[NAV_SECTIONS[group.section].labelKey]}
                </p>
              ) : null}
              {group.items.map((item) => {
                const active = isNavItemActive(pathname, item.href, visibleItems);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-lg px-3 text-base font-medium transition-colors",
                      "focus-visible:ring-sidebar-ring focus-visible:ring-2 focus-visible:outline-none",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <Icon className="size-5 shrink-0" aria-hidden="true" />
                    {navLabel(dict, item.labelKey)}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border px-5 py-4">
          <p className="text-xs text-sidebar-foreground/60">
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
      </SheetContent>
    </Sheet>
  );
}
