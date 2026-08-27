import Link from "next/link";
import { ScrollTextIcon } from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDateTime } from "@/lib/datetime";
import { PageHeader } from "@/components/shared/page-header";
import { UrlPagination } from "@/components/shared/url-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import {
  AUDIT_ACTION_OPTIONS,
  AUDIT_ENTITY_OPTIONS,
  listAuditActors,
  listAuditLogs,
} from "@/server/audit/queries";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/settings/audit-log");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const date = single(params.date);
  const userId = single(params.userId);
  const action = single(params.action);
  const entityType = single(params.entityType);
  const q = single(params.q);
  const page = Math.max(1, Number.parseInt(single(params.page) ?? "1", 10) || 1);

  const [result, actors] = await Promise.all([
    listAuditLogs({ date, userId, action, entityType, q, page }),
    listAuditActors(),
  ]);

  const selectClass =
    "border-muted bg-background h-9 rounded-md border px-2 text-sm min-w-32";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={dict.auditLog.title} subtitle={dict.auditLog.subtitle} />

      {/* Filters — GET form, read-only page */}
      <form
        method="get"
        className="border-muted flex flex-wrap items-end gap-2 rounded-lg border p-3"
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{dict.auditLog.filters.date}</span>
          <input
            type="date"
            name="date"
            defaultValue={date ?? ""}
            className={selectClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{dict.auditLog.filters.user}</span>
          <select name="userId" defaultValue={userId ?? ""} className={selectClass}>
            <option value="">{dict.auditLog.filters.allUsers}</option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{dict.auditLog.filters.action}</span>
          <select name="action" defaultValue={action ?? ""} className={selectClass}>
            <option value="">{dict.auditLog.filters.allActions}</option>
            {AUDIT_ACTION_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{dict.auditLog.filters.entityType}</span>
          <select
            name="entityType"
            defaultValue={entityType ?? ""}
            className={selectClass}
          >
            <option value="">{dict.auditLog.filters.allEntityTypes}</option>
            {AUDIT_ENTITY_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{dict.auditLog.filters.entityId}</span>
          <input
            type="text"
            name="q"
            defaultValue={q ?? ""}
            placeholder={dict.auditLog.filters.entityIdPlaceholder}
            className={selectClass}
          />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="bg-primary text-primary-foreground h-9 rounded-md px-3 text-sm font-medium"
          >
            {dict.auditLog.filters.apply}
          </button>
          <Link
            href="/settings/audit-log"
            className="border-muted hover:bg-muted h-9 rounded-md border px-3 text-sm font-medium leading-9"
          >
            {dict.auditLog.filters.clear}
          </Link>
        </div>
      </form>

      <p className="text-muted-foreground text-sm">
        {dict.common.resultsCount.replace("{count}", String(result.total))}
      </p>

      {result.rows.length === 0 ? (
        <EmptyState
          icon={ScrollTextIcon}
          title={dict.auditLog.empty}
          description={dict.auditLog.emptyHint}
        />
      ) : (
        <div className="border-muted overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium" scope="col">
                  {dict.auditLog.columns.timestamp}
                </th>
                <th className="px-3 py-2 text-start font-medium" scope="col">
                  {dict.auditLog.columns.actor}
                </th>
                <th className="px-3 py-2 text-start font-medium" scope="col">
                  {dict.auditLog.columns.action}
                </th>
                <th className="px-3 py-2 text-start font-medium" scope="col">
                  {dict.auditLog.columns.entityType}
                </th>
                <th className="px-3 py-2 text-start font-medium" scope="col">
                  {dict.auditLog.columns.entityId}
                </th>
                <th className="px-3 py-2 text-start font-medium" scope="col">
                  {dict.auditLog.columns.metadata}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.id} className="border-muted border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {formatZonedDateTime(row.createdAt, locale)}
                  </td>
                  <td className="px-3 py-2" dir="auto">
                    {row.actorName ?? dict.auditLog.unknownActor}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{row.action}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.entityType}</td>
                  <td className="max-w-40 truncate px-3 py-2 font-mono text-xs" dir="ltr">
                    {row.entityId ?? "—"}
                  </td>
                  <td className="max-w-64 px-3 py-2 text-xs opacity-80" dir="auto">
                    {row.metadataSummary}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <UrlPagination page={result.page} pageCount={result.pageCount} />

      <p className="text-muted-foreground text-xs">{dict.auditLog.readOnlyNote}</p>
    </div>
  );
}
