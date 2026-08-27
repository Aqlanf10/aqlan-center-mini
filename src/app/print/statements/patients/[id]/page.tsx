import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDate } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PrintButton } from "@/components/print/print-button";
import { PrintMasthead } from "@/components/print/print-masthead";
import { getPatientStatement } from "@/server/finance/statements";
import { recordStatementPrintAction } from "@/server/finance/voucher-actions";

export const dynamic = "force-dynamic";

export default async function PatientStatementPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["ADMIN", "RECEPTION"], "/patients");
  const { locale, dict } = await getI18n();
  const { id } = await params;

  const statement = await getPatientStatement(id);
  if (!statement) {
    notFound();
  }

  await recordStatementPrintAction("patient", id);

  const { patient, lines, balances } = statement;

  return (
    <div className="pb-24">
      <div className="print-sheet print-sheet--a4 mx-auto border shadow-sm">
        <PrintMasthead subtitle={dict.print.patientStatement} />

        <div className="mt-4 space-y-1 text-sm">
          <p className="font-semibold">{patient.fullName}</p>
          <p className="font-mono text-xs" dir="ltr">
            {patient.fileNumber} · {patient.mobile}
          </p>
        </div>

        {lines.length === 0 ? (
          <p className="text-muted-foreground mt-6 text-center text-sm">
            {dict.financeReports.noData}
          </p>
        ) : (
          <table className="print-table mt-4 w-full text-sm">
            <thead>
              <tr className="border-b-2 border-black text-start">
                <th className="py-2 text-start font-medium">{dict.print.date}</th>
                <th className="py-2 text-start font-medium">
                  {dict.financeReports.charges}
                </th>
                <th className="py-2 text-start font-medium">
                  {dict.financeReports.collections}
                </th>
                <th className="py-2 text-start font-medium">
                  {dict.financeVouchers.columns.number}
                </th>
                <th className="py-2 text-start font-medium">
                  {dict.print.description}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={`${line.kind}-${line.id}`} className="border-b">
                  <td className="py-1.5 whitespace-nowrap">
                    {formatZonedDate(line.date, locale)}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {line.kind === "charge"
                      ? formatMoney(
                          Math.round(parseFloat(line.amount) * 100),
                          line.currency,
                          locale
                        )
                      : ""}
                  </td>
                  <td className="py-1.5" dir="ltr">
                    {line.kind === "payment"
                      ? formatMoney(
                          Math.round(parseFloat(line.amount) * 100),
                          line.currency,
                          locale
                        )
                      : ""}
                  </td>
                  <td className="py-1.5 font-mono text-xs" dir="ltr">
                    {line.voucherNumber ?? ""}
                  </td>
                  <td className="py-1.5">{line.description ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Balances per currency — never mixed */}
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
