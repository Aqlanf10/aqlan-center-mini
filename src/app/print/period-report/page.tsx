import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatMoney } from "@/lib/money";
import { PrintButton } from "@/components/print/print-button";
import { PrintMasthead } from "@/components/print/print-masthead";
import { getPeriodFinancial } from "@/server/finance/reports";
import { recordReportPrintAction } from "@/server/finance/voucher-actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PeriodReportPrintPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/finance/reports");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const report = await getPeriodFinancial({
    preset: single(params.preset),
    from: single(params.from),
    to: single(params.to),
  });

  await recordReportPrintAction("period-report", {
    preset: report.range.preset,
  });

  const presetLabel =
    report.range.preset === "today"
      ? dict.reports.presets.today
      : report.range.preset === "last7days"
        ? dict.reports.presets.last7days
        : report.range.preset === "thisMonth"
          ? dict.reports.presets.thisMonth
          : dict.reports.presets.custom;

  return (
    <div className="pb-24">
      <div className="print-sheet print-sheet--a4 mx-auto border shadow-sm">
        <PrintMasthead subtitle={dict.print.periodReport} />

        <p className="mt-4 text-sm font-semibold">{presetLabel}</p>

        {/* Charges / collections / treasury flow per currency */}
        <h2 className="mt-4 mb-2 text-sm font-bold">
          {dict.financeReports.charges} · {dict.financeReports.collections} ·{" "}
          {dict.financeReports.netCashFlow}
        </h2>
        <table className="print-table w-full text-sm">
          <thead>
            <tr className="border-b-2 border-black">
              <th className="py-1.5 text-start font-medium" />
              {(["YER", "SAR", "USD"] as const).map((currency) => (
                <th key={currency} className="py-1.5 text-start font-medium" dir="ltr">
                  {currency}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["charges", dict.financeReports.charges, report.chargesMinor],
                ["collections", dict.financeReports.collections, report.collectionsMinor],
                [
                  "treasury-in",
                  dict.financeReports.treasuryReceipts,
                  report.treasuryReceiptsMinor,
                ],
                [
                  "treasury-out",
                  dict.financeReports.treasuryPayments,
                  report.treasuryPaymentsMinor,
                ],
              ] as const
            ).map(([key, label, rows]) => (
              <tr key={key} className="border-b">
                <td className="py-1.5 font-medium">{label}</td>
                {(["YER", "SAR", "USD"] as const).map((currency) => (
                  <td key={currency} className="py-1.5" dir="ltr">
                    {formatMoney(
                      rows.find((row) => row.currency === currency)?.minor ?? 0,
                      currency,
                      locale
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Expenses by category */}
        <h2 className="mt-6 mb-2 text-sm font-bold">{dict.financeReports.expensesByCategory}</h2>
        {report.expensesByCategory.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.financeReports.noData}</p>
        ) : (
          <table className="print-table w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="py-1.5 text-start font-medium">{dict.financeReports.expensesByCategory}</th>
                <th className="py-1.5 text-start font-medium">{dict.print.amount}</th>
              </tr>
            </thead>
            <tbody>
              {report.expensesByCategory.map((row) => (
                <tr key={`${row.categoryId}:${row.currency}`} className="border-b">
                  <td className="py-1.5">
                    {locale === "ar" ? row.nameAr : row.nameEn} ({row.currency})
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(row.minor, row.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Balances */}
        <h2 className="mt-6 mb-2 text-sm font-bold">
          {dict.financeReports.patientBalances} · {dict.financeReports.doctorDues}
        </h2>
        <table className="print-table w-full text-sm">
          <tbody>
            {report.patientBalancesMinor.map((row) => (
              <tr key={`pb-${row.currency}`} className="border-b">
                <td className="py-1.5">
                  {dict.financeReports.patientBalances} ({row.currency})
                </td>
                <td className="py-1.5 text-end" dir="ltr">
                  {formatMoney(row.minor, row.currency, locale)}
                </td>
              </tr>
            ))}
            {report.doctorDuesMinor.map((row) => (
              <tr key={`dd-${row.doctorId}`} className="border-b">
                <td className="py-1.5">
                  {row.doctorName} ({row.currency})
                </td>
                <td className="py-1.5 text-end" dir="ltr">
                  {formatMoney(row.minor, row.currency, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Lab & supplier balances */}
        <h2 className="mt-6 mb-2 text-sm font-bold">
          {dict.financeReports.labBalances} · {dict.financeReports.supplierBalances}
        </h2>
        <table className="print-table w-full text-sm">
          <tbody>
            {report.labBalances.map((row) => (
              <tr key={`lab-${row.labId}`} className="border-b">
                <td className="py-1.5">
                  {row.labName} ({row.currency})
                </td>
                <td className="py-1.5 text-end" dir="ltr">
                  {formatMoney(row.balanceMinor, row.currency, locale)}
                </td>
              </tr>
            ))}
            {report.supplierBalances.map((row) => (
              <tr key={`sup-${row.supplierId}`} className="border-b">
                <td className="py-1.5">
                  {row.supplierName} ({row.currency})
                </td>
                <td className="py-1.5 text-end" dir="ltr">
                  {formatMoney(row.balanceMinor, row.currency, locale)}
                </td>
              </tr>
            ))}
            {report.labBalances.length === 0 && report.supplierBalances.length === 0 ? (
              <tr>
                <td className="text-muted-foreground py-1.5">{dict.financeReports.noData}</td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <p className="text-muted-foreground mt-4 text-xs">
          {dict.financeReports.currencyWarning}
        </p>
      </div>

      <p className="print-hide text-muted-foreground mt-3 text-center text-xs">
        {dict.print.printHint}
      </p>
      <PrintButton />
    </div>
  );
}
