import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PrintButton } from "@/components/print/print-button";
import { PrintMasthead } from "@/components/print/print-masthead";
import { getSupplierStatement } from "@/server/finance/statements";
import { recordStatementPrintAction } from "@/server/finance/voucher-actions";

export const dynamic = "force-dynamic";

export default async function SupplierStatementPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["ADMIN"], "/suppliers");
  const { locale, dict } = await getI18n();
  const { id } = await params;

  const statement = await getSupplierStatement(id);
  if (!statement) {
    notFound();
  }

  await recordStatementPrintAction("supplier", id);

  const { supplier, invoiceRows, paymentRows, balances } = statement;

  return (
    <div className="pb-24">
      <div className="print-sheet print-sheet--a4 mx-auto border shadow-sm">
        <PrintMasthead subtitle={dict.print.supplierStatement} />

        <div className="mt-4 space-y-1 text-sm">
          <p className="font-semibold">{supplier.name}</p>
          <p className="text-xs" dir="ltr">
            {supplier.phone ?? ""} {supplier.address ? `· ${supplier.address}` : ""}
          </p>
        </div>

        {/* Purchase invoices */}
        <h2 className="mt-4 mb-2 text-sm font-bold">{dict.print.statements.invoice}</h2>
        {invoiceRows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.financeReports.noData}</p>
        ) : (
          <table className="print-table w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="py-1.5 text-start font-medium">{dict.print.date}</th>
                <th className="py-1.5 text-start font-medium">{dict.financeVouchers.columns.number}</th>
                <th className="py-1.5 text-start font-medium">{dict.suppliers.fields.supplierRef}</th>
                <th className="py-1.5 text-start font-medium">{dict.print.amount}</th>
                <th className="py-1.5 text-start font-medium">{dict.commissions.columns.status}</th>
              </tr>
            </thead>
            <tbody>
              {invoiceRows.map((row) => (
                <tr key={row.id} className="border-b">
                  <td className="py-1.5 whitespace-nowrap">
                    {formatZonedDate(row.invoiceDate, locale)}
                  </td>
                  <td className="py-1.5 font-mono text-xs" dir="ltr">
                    {row.invoiceNumber}
                  </td>
                  <td className="py-1.5 text-xs" dir="ltr">
                    {row.supplierRef ?? ""}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(
                      Math.round(parseFloat(row.totalAmount) * 100),
                      row.currency,
                      locale
                    )}
                  </td>
                  <td className="py-1.5">
                    {row.status === "ACTIVE"
                      ? dict.financeVouchers.active
                      : dict.statuses.appointment.CANCELLED}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Payments */}
        <h2 className="mt-6 mb-2 text-sm font-bold">{dict.print.statements.paymentOut}</h2>
        {paymentRows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.financeReports.noData}</p>
        ) : (
          <table className="print-table w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="py-1.5 text-start font-medium">{dict.print.date}</th>
                <th className="py-1.5 text-start font-medium">{dict.financeVouchers.columns.number}</th>
                <th className="py-1.5 text-start font-medium">{dict.print.amount}</th>
                <th className="py-1.5 text-start font-medium">{dict.commissions.columns.status}</th>
              </tr>
            </thead>
            <tbody>
              {paymentRows.map((row) => (
                <tr key={row.id} className="border-b">
                  <td className="py-1.5 whitespace-nowrap">
                    {formatZonedDate(row.voucherDate, locale)}
                  </td>
                  <td className="py-1.5 font-mono text-xs" dir="ltr">
                    {row.voucherNumber}
                    {row.reversalOfVoucherId ? " ↩" : ""}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(
                      Math.round(parseFloat(row.amount) * 100),
                      row.currency,
                      locale
                    )}
                  </td>
                  <td className="py-1.5">
                    {row.reversalOfVoucherId
                      ? dict.financeVouchers.isReversal
                      : dict.financeVouchers.active}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Balance per currency */}
        <div className="print-avoid-break mt-6 space-y-1 text-sm">
          <p className="font-semibold">{dict.print.balanceDue}</p>
          {[...balances.entries()].map(([currency, minor]) => (
            <div key={currency} className="flex justify-between" dir="ltr">
              <span>{currency}</span>
              <span className="font-bold">{formatMoney(minor, currency, locale)}</span>
            </div>
          ))}
          {balances.size === 0 ? (
            <p className="text-muted-foreground">{dict.financeReports.noData}</p>
          ) : null}
        </div>
      </div>

      <p className="print-hide text-muted-foreground mt-3 text-center text-xs">
        {dict.print.printHint}
      </p>
      <PrintButton />
    </div>
  );
}
