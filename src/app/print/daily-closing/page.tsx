import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatMoney } from "@/lib/money";
import { PrintButton } from "@/components/print/print-button";
import { PrintMasthead } from "@/components/print/print-masthead";
import { getDailyClosing } from "@/server/finance/reports";
import { recordReportPrintAction } from "@/server/finance/voucher-actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DailyClosingPrintPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole(["ADMIN"], "/finance/reports");
  const { locale, dict } = await getI18n();
  const params = await searchParams;

  const dateParam = Array.isArray(params.date) ? params.date[0] : params.date;
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : undefined;

  const closing = await getDailyClosing(date);
  await recordReportPrintAction("daily-closing", { date: closing.dateIso });

  return (
    <div className="pb-24">
      <div className="print-sheet print-sheet--a4 mx-auto border shadow-sm">
        <PrintMasthead subtitle={dict.print.dailyClosingReport} />

        <p className="mt-4 text-sm font-semibold" dir="ltr">
          {dict.financeReports.closingDate}: {closing.dateIso}
        </p>

        {/* Opening / net / closing per account */}
        <h2 className="mt-4 mb-2 text-sm font-bold">{dict.financeReports.dailyClosing}</h2>
        <table className="print-table w-full text-sm">
          <thead>
            <tr className="border-b-2 border-black">
              <th className="py-1.5 text-start font-medium">{dict.financeVouchers.columns.account}</th>
              <th className="py-1.5 text-start font-medium">{dict.financeReports.openingBalance}</th>
              <th className="py-1.5 text-start font-medium">{dict.financeReports.netMovement}</th>
              <th className="py-1.5 text-start font-medium">{dict.financeReports.closingBalance}</th>
            </tr>
          </thead>
          <tbody>
            {closing.closing.map((close) => {
              const open = closing.opening.find((o) => o.cashAccountId === close.cashAccountId);
              const net = close.minor - (open?.minor ?? 0);
              return (
                <tr key={close.cashAccountId} className="border-b">
                  <td className="py-1.5">
                    {close.name} ({close.currency})
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(open?.minor ?? 0, close.currency, locale)}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(net, close.currency, locale)}
                  </td>
                  <td className="py-1.5 font-bold" dir="ltr">
                    {formatMoney(close.minor, close.currency, locale)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Breakdown by method */}
        <h2 className="mt-6 mb-2 text-sm font-bold">{dict.financeReports.byMethod}</h2>
        {closing.rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.financeReports.noData}</p>
        ) : (
          <table className="print-table w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="py-1.5 text-start font-medium">{dict.financeVouchers.columns.account}</th>
                <th className="py-1.5 text-start font-medium">{dict.financeVouchers.fields.paymentMethod}</th>
                <th className="py-1.5 text-start font-medium">{dict.financeReports.receipts}</th>
                <th className="py-1.5 text-start font-medium">{dict.financeReports.payments}</th>
                <th className="py-1.5 text-start font-medium">{dict.financeReports.netMovement}</th>
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
                  <tr key={`${row.cashAccountId}:${row.currency}:${row.method}`} className="border-b">
                    <td className="py-1.5">
                      {row.cashAccountName} ({row.currency})
                    </td>
                    <td className="py-1.5">{dict.financeVouchers.paymentMethods[row.method]}</td>
                    <td className="py-1.5" dir="ltr">
                      {formatMoney(row.receiptGrossMinor, row.currency, locale)}
                    </td>
                    <td className="py-1.5" dir="ltr">
                      {formatMoney(row.paymentGrossMinor, row.currency, locale)}
                    </td>
                    <td className="py-1.5 font-bold" dir="ltr">
                      {formatMoney(net, row.currency, locale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Legacy transparency */}
        {closing.legacyPaymentsMinor.length > 0 ? (
          <p className="mt-4 text-xs">
            {dict.financeReports.legacyPayments}:{" "}
            {closing.legacyPaymentsMinor
              .map((row) => formatMoney(row.minor, row.currency, locale))
              .join(" · ")}
          </p>
        ) : null}

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
