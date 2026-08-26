"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Label } from "@/components/ui/label";
import {
  Select as NativeSelect,
  type SelectOption,
} from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";

/**
 * URL-driven filter select: swaps one query param and keeps the rest.
 * Server-rendered lists react without any client state.
 */
export function UrlFilterSelect({
  paramName,
  label,
  anyLabel,
  options,
}: {
  paramName: string;
  label: string;
  anyLabel: string;
  options: SelectOption[];
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const value = searchParams.get(paramName) ?? "";

  function handleChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) {
      params.set(paramName, next);
    } else {
      params.delete(paramName);
    }
    params.delete("page");
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`filter-${paramName}`} className="text-muted-foreground text-xs">
        {label}
      </Label>
      <NativeSelect
        id={`filter-${paramName}`}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        disabled={pending}
        aria-label={label}
        options={[{ value: "", label: anyLabel }, ...options]}
        className="sm:w-44"
      />
      <span className="sr-only">{pending ? dict.common.loading : ""}</span>
    </div>
  );
}
