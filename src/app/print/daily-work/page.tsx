import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { getTodayIsoDate, zonedTimeToUtc } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PrintButton } from "@/components/print/print-button";
import { PrintMasthead } from "@/components/print/print-masthead";
import { getDayWorkItems, getWorkSummary } from "@/server/services/work-items";
import { recordReportPrintAction } from "@/server/finance/voucher-actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DailyWorkPrintPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/reports/daily-work");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const dateParam = Array.isArray(params.date) ? params.date[0] : params.date;
  const dateIso =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : getTodayIsoDate();
  const [y, m, d] = dateIso.split("-").map(Number);
  const startUtc = zonedTimeToUtc({ year: y ?? 1970, month: m ?? 1, day: d ?? 1 });
  const endUtc = zonedTimeToUtc({ year: y ?? 1970, month: m ?? 1, day: (d ?? 1) + 1 });

  const [summary, details] = await Promise.all([
    getWorkSummary(startUtc, endUtc),
    getDayWorkItems(startUtc, endUtc),
  ]);

  await recordReportPrintAction("daily-work", { date: dateIso });

  const activeItems = details.filter((item) => item.status === "ACTIVE");

  return (
    <div className="pb-24">
      <div className="print-sheet print-sheet--a4 mx-auto border shadow-sm">
        <PrintMasthead subtitle={dict.todayWork.todayWorkReport} />

        <p className="mt-4 text-sm font-semibold" dir="ltr">
          {dateIso}
        </p>

        {/* Summary */}
        <h2 className="mt-4 mb-2 text-sm font-bold">{dict.todayWork.title}</h2>
        {summary.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.todayWork.empty}</p>
        ) : (
          <table className="print-table w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="py-1.5 text-start font-medium">{dict.todayWork.service}</th>
                <th className="py-1.5 text-start font-medium">{dict.todayWork.doctor}</th>
                <th className="py-1.5 text-start font-medium">{dict.todayWork.count}</th>
                <th className="py-1.5 text-start font-medium">{dict.todayWork.total}</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.key} className="border-b">
                  <td className="py-1.5">{locale === "ar" ? row.serviceNameAr : row.serviceNameEn}</td>
                  <td className="py-1.5">{row.doctorName}</td>
                  <td className="py-1.5">{row.count}</td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(row.totalMinor, row.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Details */}
        <h2 className="mt-6 mb-2 text-sm font-bold">{dict.todayWork.detailTitle}</h2>
        {activeItems.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.todayWork.empty}</p>
        ) : (
          <table className="print-table w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="py-1.5 text-start font-medium">{dict.todayWork.patient}</th>
                <th className="py-1.5 text-start font-medium">{dict.todayWork.service}</th>
                <th className="py-1.5 text-start font-medium">{dict.todayWork.doctor}</th>
                <th className="py-1.5 text-start font-medium">{dict.workItems.columns.quantity}</th>
                <th className="py-1.5 text-start font-medium">{dict.workItems.columns.total}</th>
              </tr>
            </thead>
            <tbody>
              {activeItems.map((item) => (
                <tr key={item.id} className="border-b">
                  <td className="py-1.5">{item.patientName}</td>
                  <td className="py-1.5">
                    {locale === "ar" ? item.serviceNameAr : item.serviceNameEn}
                  </td>
                  <td className="py-1.5">{item.doctorName}</td>
                  <td className="py-1.5" dir="ltr">
                    {item.quantity}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(
                      Math.round(parseFloat(item.total) * 100),
                      item.currency,
                      locale
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="print-hide text-muted-foreground mt-3 text-center text-xs">
        {dict.print.printHint}
      </p>
      <PrintButton />
    </div>
  );
}
