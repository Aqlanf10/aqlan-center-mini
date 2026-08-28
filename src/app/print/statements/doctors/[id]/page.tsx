import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PrintButton } from "@/components/print/print-button";
import { PrintMasthead } from "@/components/print/print-masthead";
import { getDoctorStatement } from "@/server/finance/statements";
import { recordStatementPrintAction } from "@/server/finance/voucher-actions";

export const dynamic = "force-dynamic";

export default async function DoctorStatementPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireRole(["ADMIN", "DOCTOR"], "/my-work");
  const { locale, dict } = await getI18n();
  const { id } = await params;

  // Doctors may only print their OWN statement (server-side).
  if (user.role === "DOCTOR" && user.id !== id) {
    notFound();
  }

  const statement = await getDoctorStatement(id);
  if (!statement) {
    notFound();
  }

  if (user.role === "ADMIN") {
    await recordStatementPrintAction("doctor", id);
  }

  const { doctor, commissionRows, workSummary } = statement;

  return (
    <div className="pb-24">
      <div className="print-sheet print-sheet--a4 mx-auto border shadow-sm">
        <PrintMasthead subtitle={dict.print.doctorStatement} />

        <p className="mt-4 font-semibold text-sm">{doctor.name}</p>

        {/* Completed work by service & currency */}
        <h2 className="mt-4 mb-2 text-sm font-bold">{dict.print.statements.work}</h2>
        {workSummary.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.financeReports.noData}</p>
        ) : (
          <table className="print-table w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="py-1.5 text-start font-medium">{dict.todayWork.service}</th>
                <th className="py-1.5 text-start font-medium">{dict.todayWork.count}</th>
                <th className="py-1.5 text-start font-medium">{dict.todayWork.total}</th>
              </tr>
            </thead>
            <tbody>
              {workSummary.map((row) => (
                <tr key={row.key} className="border-b">
                  <td className="py-1.5">
                    {locale === "ar" ? row.serviceNameAr : row.serviceNameEn}
                  </td>
                  <td className="py-1.5">{row.count}</td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(row.totalMinor, row.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Commissions */}
        <h2 className="mt-6 mb-2 text-sm font-bold">{dict.print.statements.commission}</h2>
        {commissionRows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{dict.financeReports.noData}</p>
        ) : (
          <table className="print-table w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="py-1.5 text-start font-medium">{dict.print.date}</th>
                <th className="py-1.5 text-start font-medium">{dict.commissions.columns.basis}</th>
                <th className="py-1.5 text-start font-medium">{dict.commissions.columns.base}</th>
                <th className="py-1.5 text-start font-medium">{dict.commissions.columns.amount}</th>
                <th className="py-1.5 text-start font-medium">{dict.commissions.columns.status}</th>
                <th className="py-1.5 text-start font-medium">
                  {dict.financeVouchers.columns.number}
                </th>
              </tr>
            </thead>
            <tbody>
              {commissionRows.map((row) => (
                <tr key={row.id} className="border-b">
                  <td className="py-1.5 whitespace-nowrap">
                    {formatZonedDate(row.createdAt, locale)}
                  </td>
                  <td className="py-1.5">{dict.commissions.basis[row.basis]}</td>
                  <td className="py-1.5" dir="ltr">
                    {formatMoney(
                      Math.round(parseFloat(row.baseAmount) * 100),
                      row.currency,
                      locale
                    )}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {row.amount
                      ? formatMoney(
                          Math.round(parseFloat(row.amount) * 100),
                          row.currency,
                          locale
                        )
                      : "—"}
                  </td>
                  <td className="py-1.5">{dict.commissions.statuses[row.status]}</td>
                  <td className="py-1.5 font-mono text-xs" dir="ltr">
                    {row.paidVoucherNumber ?? ""}
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
