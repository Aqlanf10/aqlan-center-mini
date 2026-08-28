"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

/**
 * URL-driven pagination controls for server-rendered lists. Preserves all
 * current query params and only swaps ?page=.
 */
export function UrlPagination({
  page,
  pageCount,
  paramName = "page",
}: {
  page: number;
  pageCount: number;
  paramName?: string;
}) {
  const { dict } = useI18n();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (pageCount <= 1) {
    return null;
  }

  const pageLabel = dict.patients.pagination.pageOf
    .replace("{page}", String(page))
    .replace("{total}", String(pageCount));

  const hrefFor = (target: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (target > 1) {
      params.set(paramName, String(target));
    } else {
      params.delete(paramName);
    }
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  return (
    <nav className="flex items-center justify-between gap-2 pt-2" aria-label="Pagination">
      <Button asChild variant="outline" size="sm" aria-disabled={page <= 1}>
        <Link
          href={hrefFor(Math.max(1, page - 1))}
          className={page <= 1 ? "pointer-events-none opacity-50" : undefined}
        >
          {dict.patients.pagination.previous}
        </Link>
      </Button>
      <span className="text-muted-foreground text-sm" aria-live="polite">
        {pageLabel}
      </span>
      <Button asChild variant="outline" size="sm" aria-disabled={page >= pageCount}>
        <Link
          href={hrefFor(Math.min(pageCount, page + 1))}
          className={
            page >= pageCount ? "pointer-events-none opacity-50" : undefined
          }
        >
          {dict.patients.pagination.next}
        </Link>
      </Button>
    </nav>
  );
}
