"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";

/**
 * URL-driven server-side search input with debounce. The query lives in
 * the URL (?q=…) so results are server-rendered, shareable and the
 * browser never downloads the full table.
 */
export function UrlSearchInput({
  placeholder,
  paramName = "q",
  delayMs = 350,
}: {
  placeholder: string;
  paramName?: string;
  delayMs?: number;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get(paramName) ?? "";
  const [value, setValue] = useState(current);
  const [syncedParam, setSyncedParam] = useState(current);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adjust local state during render when the URL changed externally
  // (e.g. a filter select reset the query) — React-recommended pattern.
  if (syncedParam !== current) {
    setSyncedParam(current);
    setValue(current);
  }

  function commit(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.trim()) {
      params.set(paramName, next.trim());
    } else {
      params.delete(paramName);
    }
    params.delete("page"); // any new search resets pagination
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function handleChange(next: string) {
    setValue(next);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => commit(next), delayMs);
  }

  return (
    <div className="relative w-full sm:max-w-xs">
      <SearchIcon
        className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <Input
        type="search"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        placeholder={placeholder}
        aria-label={dict.common.search}
        className="ps-8"
      />
    </div>
  );
}
