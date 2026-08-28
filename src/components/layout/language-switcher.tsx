"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, LanguagesIcon, LoaderCircleIcon } from "lucide-react";

import { setLocaleAction } from "@/app/actions/set-locale";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";

/** Header language switcher — persists the choice in a cookie. */
export function LanguageSwitcher() {
  const { dict, locale } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  function switchTo(next: Locale) {
    if (next === locale) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      await setLocaleAction(next);
      router.refresh();
      setOpen(false);
    });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          aria-label={dict.common.switchLanguage}
          disabled={pending}
        >
          {pending ? (
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <LanguagesIcon className="size-4" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">{LOCALE_LABELS[locale]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{dict.common.language}</DropdownMenuLabel>
        {LOCALES.map((item) => (
          <DropdownMenuItem
            key={item}
            onSelect={() => switchTo(item)}
            aria-checked={item === locale}
            className="min-h-9"
          >
            {item === locale ? (
              <CheckIcon aria-hidden="true" />
            ) : (
              <span className="size-4" aria-hidden="true" />
            )}
            {LOCALE_LABELS[item]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
