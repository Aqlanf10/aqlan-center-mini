import Link from "next/link";
import { PrinterIcon, StethoscopeIcon } from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { addDaysToIsoDate, getTodayIsoDate, zonedTimeToUtc } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { getDayWorkItems, getWorkSummary } from "@/server/services/work-items";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Resolve a day range from ?date=YYYY-MM-DD (default today, Asia/Aden). */
function dayRange(dateIso: string | undefined): { startUtc: Date; endUtc: Date; dateIso: string } {
  const target =
    dateIso && /^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? dateIso : getTodayIsoDate();
  const [y, m, d] = target.split("-").map(Number);
  return {
    startUtc: zonedTimeToUtc({ year: y ?? 1970, month: m ?? 1, day: d ?? 1 }),
    endUtc: zonedTimeToUtc({ year: y ?? 1970, month: m ?? 1, day: (d ?? 1) + 1 }),
    dateIso: target,
  };
}

export default async function DailyWorkReportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/reports/daily-work");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const { startUtc, endUtc, dateIso } = dayRange(single(params.date));
  const summary = await getWorkSummary(startUtc, endUtc);
  const details = await getDayWorkItems(startUtc, endUtc);

  const previousDate = addDaysToIsoDate(dateIso, -1);
  const nextDate = addDaysToIsoDate(dateIso, 1);

  const activeItems = details.filter((item) => item.status === "ACTIVE");
  const cancelledItems = details.filter((item) => item.status === "CANCELLED");

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.todayWork.todayWorkReport}
        subtitle={dict.todayWork.subtitle}
        actions={
          <Link
            href={`/print/daily-work?date=${dateIso}`}
            target="_blank"
            className="text-primary inline-flex items-center gap-2 text-sm font-medium hover:underline"
          >
            <PrinterIcon className="size-4" aria-hidden="true" />
            {dict.financeReports.print}
          </Link>
        }
      />

      {/* Day navigation */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <Link
          href={`/reports/daily-work?date=${previousDate}`}
          className="bg-muted hover:bg-accent rounded-md px-3 py-1.5"
        >
          ← {previousDate}
        </Link>
        <span className="font-medium">{dateIso}</span>
        <Link
          href={`/reports/daily-work?date=${nextDate}`}
          className="bg-muted hover:bg-accent rounded-md px-3 py-1.5"
        >
          {nextDate} →
        </Link>
      </div>

      {/* Summary by service & doctor */}
      {summary.length === 0 ? (
        <EmptyState
          icon={StethoscopeIcon}
          title={dict.todayWork.empty}
          description={dict.todayWork.emptyHint}
        />
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-muted-foreground bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-2.5 text-start font-medium">{dict.todayWork.service}</th>
                <th className="px-3 py-2.5 text-start font-medium">{dict.todayWork.doctor}</th>
                <th className="px-3 py-2.5 text-start font-medium">{dict.todayWork.count}</th>
                <th className="px-3 py-2.5 text-start font-medium">{dict.todayWork.total}</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.key} className="border-b last:border-0">
                  <td className="px-3 py-2.5 font-medium">
                    {locale === "ar" ? row.serviceNameAr : row.serviceNameEn}
                  </td>
                  <td className="px-3 py-2.5">{row.doctorName}</td>
                  <td className="px-3 py-2.5">{row.count}</td>
                  <td className="px-3 py-2.5 font-semibold" dir="ltr">
                    {formatMoney(row.totalMinor, row.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Details: patients & visits */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{dict.todayWork.detailTitle}</h2>
        {activeItems.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.todayWork.empty}</p>
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.todayWork.patient}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.todayWork.service}</th>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.todayWork.doctor}</th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.workItems.columns.quantity}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.workItems.columns.total}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">{dict.todayWork.visit}</th>
                </tr>
              </thead>
              <tbody>
                {activeItems.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/patients/${item.patientId}`}
                        className="text-primary hover:underline"
                      >
                        {item.patientName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      {locale === "ar" ? item.serviceNameAr : item.serviceNameEn}
                    </td>
                    <td className="px-3 py-2.5">{item.doctorName}</td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {item.quantity}
                    </td>
                    <td className="px-3 py-2.5 font-semibold" dir="ltr">
                      {formatMoney(
                        Math.round(parseFloat(item.total) * 100),
                        item.currency,
                        locale
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/visits/${item.visitId}`}
                        className="text-primary hover:underline"
                      >
                        {dict.common.view}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Cancelled items — reported separately, never silently dropped */}
      {cancelledItems.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{dict.todayWork.cancelledItems}</h2>
          <ul className="text-muted-foreground space-y-1 text-sm">
            {cancelledItems.map((item) => (
              <li key={item.id}>
                {item.patientName} — {locale === "ar" ? item.serviceNameAr : item.serviceNameEn} —{" "}
                {item.doctorName} —{" "}
                <span dir="ltr">
                  {formatMoney(
                    Math.round(parseFloat(item.total) * 100),
                    item.currency,
                    locale
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
