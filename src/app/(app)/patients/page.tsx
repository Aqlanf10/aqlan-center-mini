import Link from "next/link";
import { eq } from "drizzle-orm";
import { UsersIcon } from "lucide-react";

import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { UrlFilterSelect } from "@/components/shared/url-filter-select";
import { UrlPagination } from "@/components/shared/url-pagination";
import { UrlSearchInput } from "@/components/shared/url-search-input";
import {
  ActiveBadge,
  TreatmentStatusBadge,
} from "@/components/shared/status-badges";
import { PatientFormDialog } from "@/components/patients/patient-form-dialog";
import { listPatients } from "@/server/patients/queries";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireUser("/patients");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const q = single(params.q);
  const status = single(params.status);
  const filterParam = single(params.filter);
  const filter =
    filterParam === "active" || filterParam === "archived"
      ? filterParam
      : "all";
  const page = Math.max(1, Number.parseInt(single(params.page) ?? "1", 10) || 1);

  const doctors = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.role, "DOCTOR"))
    .limit(50);

  const result = await listPatients({ q, status, filter, page });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={dict.patients.title}
        subtitle={dict.patients.subtitle}
        actions={
          <PatientFormDialog doctors={doctors} trigger={dict.patients.addPatient} />
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <UrlSearchInput placeholder={dict.patients.searchPlaceholder} />
          <div className="flex flex-wrap items-end gap-3">
            <UrlFilterSelect
              paramName="status"
              label={dict.patients.list.status}
              anyLabel={dict.patients.filters.status}
              options={(["NEW", "ACTIVE", "RETENTION", "COMPLETED", "PAUSED"] as const).map(
                (value) => ({ value, label: dict.statuses.treatment[value] })
              )}
            />
            <UrlFilterSelect
              paramName="filter"
              label={dict.common.status}
              anyLabel={dict.patients.filters.all}
              options={[
                { value: "active", label: dict.patients.filters.active },
                { value: "archived", label: dict.patients.filters.archived },
              ]}
            />
          </div>
        </div>

        {result.total > 0 ? (
          <p className="text-muted-foreground text-sm">
            {dict.common.resultsCount.replace("{count}", String(result.total))}
          </p>
        ) : null}
      </div>

      {result.rows.length === 0 ? (
        q || status || filter !== "all" ? (
          <EmptyState
            icon={UsersIcon}
            title={dict.patients.emptySearch}
            description={dict.patients.searchPlaceholder}
          />
        ) : (
          <EmptyState
            icon={UsersIcon}
            title={dict.patients.emptyTitle}
            description={dict.patients.emptyHint}
          />
        )
      ) : (
        <>
          {/* Desktop table (hidden on phones) */}
          <div className="border-muted hidden overflow-hidden rounded-lg border md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.patients.list.fileNumber}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.patients.list.name}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.patients.list.mobile}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.patients.list.status}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.patients.list.doctor}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.followUp.columns.lastVisit}
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-muted/40 border-muted border-t transition-colors"
                  >
                    <td className="px-3 py-2.5 font-mono text-xs" dir="ltr">
                      <Link
                        href={`/patients/${row.id}`}
                        className="hover:text-primary focus-visible:ring-ring/50 rounded outline-none focus-visible:ring-[3px]"
                      >
                        {row.fileNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/patients/${row.id}`}
                        className="hover:text-primary font-medium rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {row.fullName}
                      </Link>
                      {!row.active ? (
                        <span className="ms-2 align-middle">
                          <ActiveBadge active={false} dict={dict} />
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {row.mobile}
                    </td>
                    <td className="px-3 py-2.5">
                      <TreatmentStatusBadge status={row.treatmentStatus} dict={dict} />
                    </td>
                    <td className="px-3 py-2.5">
                      {row.doctorName ?? dict.patients.fields.noDoctor}
                    </td>
                    <td className="px-3 py-2.5">
                      {row.lastVisitDate
                        ? formatZonedDate(new Date(row.lastVisitDate), locale)
                        : dict.patients.profile.summary.never}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="flex flex-col gap-2 md:hidden">
            {result.rows.map((row) => (
              <li key={row.id} className="border-muted rounded-lg border p-3">
                <Link
                  href={`/patients/${row.id}`}
                  className="flex flex-col gap-1.5 rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{row.fullName}</span>
                    <span className="text-muted-foreground font-mono text-xs" dir="ltr">
                      {row.fileNumber}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <TreatmentStatusBadge status={row.treatmentStatus} dict={dict} />
                    {!row.active ? <ActiveBadge active={false} dict={dict} /> : null}
                  </span>
                  <span className="text-muted-foreground text-sm" dir="ltr">
                    {row.mobile}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <UrlPagination page={result.page} pageCount={result.pageCount} />
        </>
      )}
    </div>
  );
}
