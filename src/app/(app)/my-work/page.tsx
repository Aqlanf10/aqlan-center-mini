import { BanknoteIcon, StethoscopeIcon } from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { getAppDayRangeUtc, addDaysToIsoDate, getTodayIsoDate, zonedTimeToUtc } from "@/lib/datetime";
import { getWorkSummary } from "@/server/services/work-items";
import { listCommissions } from "@/server/commissions/engine";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, "secondary" | "default" | "outline" | "destructive"> = {
  PENDING: "secondary",
  APPROVED: "default",
  PAID: "outline",
  REVERSED: "destructive",
};

export default async function MyWorkPage() {
  const user = await requireRole(["DOCTOR", "ADMIN"], "/my-work");
  const { locale, dict } = await getI18n();

  // Last 30 days of the doctor's own completed work (server-filtered).
  const todayIso = getTodayIsoDate();
  const fromIso = addDaysToIsoDate(todayIso, -30);
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const startUtc = zonedTimeToUtc({ year: fy ?? 1970, month: fm ?? 1, day: fd ?? 1 });
  const { endUtc } = getAppDayRangeUtc(new Date());

  const summary = await getWorkSummary(startUtc, endUtc, { doctorId: user.id });
  const commissions = await listCommissions({ doctorId: user.id, limit: 100 });

  const ownCommissions = commissions; // already filtered by doctorId

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.myWork.title}
        subtitle={dict.myWork.subtitle}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{dict.myWork.workSummary}</h2>
        {summary.length === 0 ? (
          <EmptyState icon={StethoscopeIcon} title={dict.myWork.empty} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.todayWork.service}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.todayWork.count}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.todayWork.total}
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.map((row) => (
                  <tr key={row.key} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-medium">
                      {locale === "ar" ? row.serviceNameAr : row.serviceNameEn}
                    </td>
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
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{dict.myWork.commissions}</h2>
        {ownCommissions.length === 0 ? (
          <EmptyState icon={BanknoteIcon} title={dict.myWork.emptyCommissions} />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-muted-foreground bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.date}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.basis}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.base}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.amount}
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    {dict.commissions.columns.status}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ownCommissions.map((commission) => (
                  <tr key={commission.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {formatZonedDate(commission.createdAt, locale)}
                    </td>
                    <td className="px-3 py-2.5">
                      {dict.commissions.basis[commission.basis]}
                    </td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {formatMoney(
                        Math.round(parseFloat(commission.baseAmount) * 100),
                        commission.currency,
                        locale
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-semibold" dir="ltr">
                      {commission.amount
                        ? formatMoney(
                            Math.round(parseFloat(commission.amount) * 100),
                            commission.currency,
                            locale
                          )
                        : dict.commissions.needsPlan}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS_BADGE[commission.status] ?? "secondary"}>
                        {dict.commissions.statuses[commission.status]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
