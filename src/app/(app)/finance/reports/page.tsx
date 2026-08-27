import Link from "next/link";
import { PrinterIcon } from "lucide-react";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { getTodayIsoDate } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { BarChart3Icon } from "lucide-react";
import { getDailyClosing, getPeriodFinancial } from "@/server/finance/reports";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function FinanceReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/finance/reports");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const view = single(params.view) === "period" ? "period" : "daily-closing";
  const date = single(params.date) ?? getTodayIsoDate();

  if (view === "period") {
    const report = await getPeriodFinancial({
      preset: single(params.preset),
      from: single(params.from),
      to: single(params.to),
    });
    const printHref = `/print/period-report?preset=${report.range.preset}${
      report.range.preset === "custom" && single(params.from) && single(params.to)
        ? `&from=${single(params.from)}&to=${single(params.to)}`
        : ""
    }`;

    return (
      <div className="space-y-6">
        <PageHeader
          title={dict.financeReports.periodReport}
          subtitle={dict.financeReports.periodReportSubtitle}
          actions={
            <Link
              href={printHref}
              target="_blank"
              className="text-primary inline-flex items-center gap-2 text-sm font-medium hover:underline"
            >
              <PrinterIcon className="size-4" aria-hidden="true" />
              {dict.financeReports.print}
            </Link>
          }
        />

        <ReportFilters currentView={view} dict={dict} />

        <div className="grid gap-3 lg:grid-cols-2">
          {/* Charges & collections per currency */}
          <div className="bg-card rounded-xl border p-4">
            <h3 className="mb-3 text-sm font-semibold">
              {dict.financeReports.charges} / {dict.financeReports.collections}
            </h3>
            <ul className="space-y-2" dir="ltr">
              {(["YER", "SAR", "USD"] as const).map((currency) => {
                const charge = report.chargesMinor.find((c) => c.currency === currency);
                const collection = report.collectionsMinor.find(
                  (c) => c.currency === currency
                );
                if (!charge && !collection) return null;
                return (
                  <li key={currency} className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-medium">{currency}</span>
                    <span className="flex gap-4">
                      <span>
                        {dict.financeReports.charges}:{" "}
                        {formatMoney(charge?.minor ?? 0, currency, locale)}
                      </span>
                      <span>
                        {dict.financeReports.collections}:{" "}
                        {formatMoney(collection?.minor ?? 0, currency, locale)}
                      </span>
                    </span>
                  </li>
                );
              })}
              {report.chargesMinor.length === 0 && report.collectionsMinor.length === 0 ? (
                <li className="text-muted-foreground text-sm">
                  {dict.financeReports.noData}
                </li>
              ) : null}
            </ul>
          </div>

          {/* Treasury flow per currency */}
          <div className="bg-card rounded-xl border p-4">
            <h3 className="mb-3 text-sm font-semibold">
              {dict.financeReports.netCashFlow}
            </h3>
            <ul className="space-y-2" dir="ltr">
              {(["YER", "SAR", "USD"] as const).map((currency) => {
                const receipt = report.treasuryReceiptsMinor.find(
                  (c) => c.currency === currency
                );
                const payment = report.treasuryPaymentsMinor.find(
                  (c) => c.currency === currency
                );
                if (!receipt && !payment) return null;
                const net = (receipt?.minor ?? 0) - (payment?.minor ?? 0);
                return (
                  <li key={currency} className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-medium">{currency}</span>
                    <span className="flex flex-wrap gap-3">
                      <span>
                        ↗ {formatMoney(receipt?.minor ?? 0, currency, locale)}
                      </span>
                      <span>
                        ↘ {formatMoney(payment?.minor ?? 0, currency, locale)}
                      </span>
                      <span className="font-semibold">
                        = {formatMoney(net, currency, locale)}
                      </span>
                    </span>
                  </li>
                );
              })}
              {report.treasuryReceiptsMinor.length === 0 &&
              report.treasuryPaymentsMinor.length === 0 ? (
                <li className="text-muted-foreground text-sm">
                  {dict.financeReports.noData}
                </li>
              ) : null}
            </ul>
          </div>

          {/* Expenses by category */}
          <div className="bg-card rounded-xl border p-4">
            <h3 className="mb-3 text-sm font-semibold">
              {dict.financeReports.expensesByCategory}
            </h3>
            {report.expensesByCategory.length === 0 ? (
              <p className="text-muted-foreground text-sm">{dict.financeReports.noData}</p>
            ) : (
              <ul className="space-y-2" dir="ltr">
                {report.expensesByCategory.map((row) => (
                  <li
                    key={`${row.categoryId}:${row.currency}`}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>
                      {locale === "ar" ? row.nameAr : row.nameEn} ({row.currency})
                    </span>
                    <span className="font-semibold">
                      {formatMoney(row.minor, row.currency, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Balances snapshot */}
          <div className="bg-card rounded-xl border p-4">
            <h3 className="mb-3 text-sm font-semibold">
              {dict.financeReports.patientBalances} ·{" "}
              {dict.financeReports.doctorDues}
            </h3>
            <ul className="space-y-2" dir="ltr">
              {report.patientBalancesMinor.map((row) => (
                <li key={`pb-${row.currency}`} className="flex justify-between text-sm">
                  <span>
                    {dict.financeReports.patientBalances} ({row.currency})
                  </span>
                  <span className="font-semibold">
                    {formatMoney(row.minor, row.currency, locale)}
                  </span>
                </li>
              ))}
              {report.doctorDuesMinor.map((row) => (
                <li key={`dd-${row.doctorId}`} className="flex justify-between text-sm">
                  <span>
                    {row.doctorName} ({row.currency})
                  </span>
                  <span className="font-semibold">
                    {formatMoney(row.minor, row.currency, locale)}
                  </span>
                </li>
              ))}
              {report.patientBalancesMinor.length === 0 &&
              report.doctorDuesMinor.length === 0 ? (
                <li className="text-muted-foreground text-sm">
                  {dict.financeReports.noData}
                </li>
              ) : null}
            </ul>
          </div>

          {/* Lab & supplier balances */}
          <div className="bg-card rounded-xl border p-4 lg:col-span-2">
            <h3 className="mb-3 text-sm font-semibold">
              {dict.financeReports.labBalances} · {dict.financeReports.supplierBalances}
            </h3>
            {report.labBalances.length === 0 && report.supplierBalances.length === 0 ? (
              <p className="text-muted-foreground text-sm">{dict.financeReports.noData}</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2" dir="ltr">
                {report.labBalances.map((row) => (
                  <Link
                    key={`lab-${row.labId}`}
                    href={`/labs?labId=${row.labId}`}
                    className="hover:bg-accent flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="truncate">
                      {row.labName} ({row.currency}) · {dict.labs.openCases}: {row.openCases}
                    </span>
                    <span className="font-semibold">
                      {formatMoney(row.balanceMinor, row.currency, locale)}
                    </span>
                  </Link>
                ))}
                {report.supplierBalances.map((row) => (
                  <Link
                    key={`sup-${row.supplierId}`}
                    href={`/suppliers?supplierId=${row.supplierId}`}
                    className="hover:bg-accent flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="truncate">
                      {row.supplierName} ({row.currency})
                    </span>
                    <span className="font-semibold">
                      {formatMoney(row.balanceMinor, row.currency, locale)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <p className="text-muted-foreground text-xs">
          {dict.financeReports.currencyWarning}
        </p>
      </div>
    );
  }

  // ---- Daily closing view ----
  const closing = await getDailyClosing(date);

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.financeReports.dailyClosing}
        subtitle={dict.financeReports.dailyClosingSubtitle}
        actions={
          <Link
            href={`/print/daily-closing?date=${closing.dateIso}`}
            target="_blank"
            className="text-primary inline-flex items-center gap-2 text-sm font-medium hover:underline"
          >
            <PrinterIcon className="size-4" aria-hidden="true" />
            {dict.financeReports.print}
          </Link>
        }
      />

      <ReportFilters currentView={view} dict={dict} />

      {/* Opening / closing per account */}
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-muted-foreground bg-muted/50 border-b">
            <tr>
              <th className="px-3 py-2.5 text-start font-medium">
                {dict.financeAccounts.fields.name}
              </th>
              <th className="px-3 py-2.5 text-start font-medium">
                {dict.financeReports.openingBalance}
              </th>
              <th className="px-3 py-2.5 text-start font-medium">
                {dict.financeReports.netMovement}
              </th>
              <th className="px-3 py-2.5 text-start font-medium">
                {dict.financeReports.closingBalance}
              </th>
            </tr>
          </thead>
          <tbody>
            {closing.closing.map((close) => {
              const open = closing.opening.find((o) => o.cashAccountId === close.cashAccountId);
              const net = close.minor - (open?.minor ?? 0);
              return (
                <tr key={close.cashAccountId} className="border-b last:border-0">
                  <td className="px-3 py-2.5 font-medium">
                    {close.name} <span dir="ltr">({close.currency})</span>
                  </td>
                  <td className="px-3 py-2.5" dir="ltr">
                    {formatMoney(open?.minor ?? 0, close.currency, locale)}
                  </td>
                  <td className="px-3 py-2.5" dir="ltr">
                    {formatMoney(net, close.currency, locale)}
                  </td>
                  <td className="px-3 py-2.5 font-semibold" dir="ltr">
                    {formatMoney(close.minor, close.currency, locale)}
                  </td>
                </tr>
              );
            })}
            {closing.closing.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-muted-foreground px-3 py-6 text-center">
                  {dict.financeReports.noData}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Movements by account + currency + method */}
      {closing.rows.length === 0 ? (
        <EmptyState
          icon={BarChart3Icon}
          title={dict.financeReports.noData}
          description={dict.financeReports.currencyWarning}
        />
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-muted-foreground bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeVouchers.columns.account}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeVouchers.fields.paymentMethod}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeReports.receipts}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeReports.receiptReversals}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeReports.payments}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeReports.paymentReversals}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.financeReports.netMovement}
                </th>
              </tr>
            </thead>
            <tbody>
              {closing.rows.map((row) => {
                const net =
                  row.receiptGrossMinor -
                  row.receiptReversalMinor -
                  row.paymentGrossMinor +
                  row.paymentReversalMinor;
                return (
                  <tr
                    key={`${row.cashAccountId}:${row.currency}:${row.method}`}
                    className="border-b last:border-0"
                  >
                    <td className="px-3 py-2.5 font-medium">
                      {row.cashAccountName} <span dir="ltr">({row.currency})</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {dict.financeVouchers.paymentMethods[row.method]}
                    </td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {formatMoney(row.receiptGrossMinor, row.currency, locale)}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground" dir="ltr">
                      {formatMoney(row.receiptReversalMinor, row.currency, locale)}
                    </td>
                    <td className="px-3 py-2.5" dir="ltr">
                      {formatMoney(row.paymentGrossMinor, row.currency, locale)}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground" dir="ltr">
                      {formatMoney(row.paymentReversalMinor, row.currency, locale)}
                    </td>
                    <td className="px-3 py-2.5 font-semibold" dir="ltr">
                      {formatMoney(net, row.currency, locale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legacy transparency line */}
      {closing.legacyPaymentsMinor.length > 0 ? (
        <div className="bg-muted/40 rounded-xl border border-dashed p-4">
          <p className="text-sm font-medium">
            {dict.financeReports.legacyPayments}
          </p>
          <ul className="mt-2 space-y-1" dir="ltr">
            {closing.legacyPaymentsMinor.map((row) => (
              <li key={row.currency} className="flex justify-between text-sm">
                <span>{row.currency}</span>
                <span className="font-semibold">
                  {formatMoney(row.minor, row.currency, locale)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

type ReportsDict = {
  financeReports: {
    dailyClosing: string;
    periodReport: string;
  };
  reports: { filterLabel: string };
};

/** View switcher (URL-driven, server-rendered). */
function ReportFilters({
  currentView,
  dict,
}: {
  currentView: "daily-closing" | "period";
  dict: ReportsDict;
}) {
  const views = [
    { key: "daily-closing" as const, href: "/finance/reports?view=daily-closing" },
    { key: "period" as const, href: "/finance/reports?view=period" },
  ];

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
      <span>{dict.reports.filterLabel}</span>
      {views.map((view) => (
        <Link
          key={view.key}
          href={view.href}
          className={
            view.key === currentView
              ? "bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium"
              : "bg-muted hover:bg-accent rounded-md px-3 py-1.5"
          }
        >
          {view.key === "daily-closing"
            ? dict.financeReports.dailyClosing
            : dict.financeReports.periodReport}
        </Link>
      ))}
    </div>
  );
}
