"use client";

import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { MobileNav } from "@/components/layout/mobile-nav";
import { UserMenu } from "@/components/layout/user-menu";
import { Separator } from "@/components/ui/separator";
import type { SessionUser } from "@/lib/auth/guards";
import { useI18n } from "@/i18n/provider";

/** Sticky application header: mobile drawer trigger, brand, language, user. */
export function AppHeader({
  user,
  brandName,
}: {
  user: SessionUser;
  brandName: string;
}) {
  const { dict } = useI18n();

  return (
    <header className="bg-background/90 supports-[backdrop-filter]:bg-background/75 sticky top-0 z-30 border-b backdrop-blur">
      <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
        <MobileNav user={user} brandName={brandName} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{brandName}</p>
          <p className="text-muted-foreground truncate text-xs">
            {dict.app.centerName}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <LanguageSwitcher />
          <Separator orientation="vertical" className="mx-1 h-6" />
          <UserMenu user={user} />
        </div>
      </div>
    </header>
  );
}
