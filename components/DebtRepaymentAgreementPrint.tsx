import { notFound } from "next/navigation";
import { readSavedRepaymentAgreement } from "@/lib/debt-repayment-agreement-db";
import { formatMoney } from "@/lib/money";
import { STANDARD_PLAN_TERMS } from "@/lib/plans";
import { PrintHeader } from "./PrintHeader";
import { PrintButton } from "./PrintButton";
import { AgreementIdentitySummary, agreementDensity, AgreementInstallmentTable, AgreementTermsAndSignatures } from "./InstallmentAgreementPresentation";

export async function DebtRepaymentAgreementPrint({ id, version, today }: { id: number; version: number; today: string }) {
  const agreement = await readSavedRepaymentAgreement(id, version, today);
  if (!agreement) notFound();
  const { source, schedule, settings } = agreement;
  const currency = schedule.target.currency;
  return <><PrintButton /><div className="sheet sheet-a4 agreement-sheet" data-density={agreementDensity(schedule.progress!.rows.length)} data-testid="saved-installment-contract" data-arrangement-id={schedule.id} data-agreement-version={schedule.version} dir="rtl">
    <PrintHeader settings={settings} title="اتفاقية خطة العلاج وجدول الأقساط" />
    <AgreementIdentitySummary patientName={source.full_name} patientNumber={source.patient_number}
      reference={source.invoice_number ? `فاتورة ${source.invoice_number}` : `الرصيد السابق ${currency}`}
      totalLabel={source.invoice_number ? "إجمالي قيمة الفاتورة" : "إجمالي الرصيد السابق"}
      totalMinor={schedule.principalMinor} paidMinor={schedule.collectedMinor} remainingMinor={schedule.remainingMinor} currency={currency} />
    {source.phone ? <p className="footer-note">رقم الهاتف: <span dir="ltr">{source.phone}</span></p> : null}
    <h3 style={{ fontSize: "11pt", fontWeight: 700, margin: "2mm 0 1mm" }}>
      جدول الأقساط والمواعيد الاستحقاقية ({schedule.progress!.rows.length} دفعات)
    </h3>
    {schedule.revisionPrincipalMinor !== schedule.principalMinor ? <p className="footer-note" style={{ marginBottom: "1mm" }}>إجمالي مبالغ هذا الجدول: {formatMoney(schedule.revisionPrincipalMinor, currency)}</p> : null}
    <AgreementInstallmentTable currency={currency} rows={schedule.progress!.rows.map((row, index) => ({
      key: index,
      number: row.kind === "down_payment" ? "مقدمة مقترحة" : index + 1 - (schedule.terms.installments[0]?.kind === "down_payment" ? 1 : 0),
      dueDate: row.dueDate, amountMinor: row.amountMinor, paid: row.remainingMinor === 0,
      settledMinor: row.settledMinor, remainingMinor: row.remainingMinor,
    }))} />
    <p className="footer-note" style={{ marginTop: "2mm" }}>المقدمة المقترحة موعد سداد وليست سند قبض. المسدد الفعلي أعلاه من السندات والتسويات المسجلة فقط.</p>
    <AgreementTermsAndSignatures terms={STANDARD_PLAN_TERMS} />
    <p className="footer-note" data-testid="agreement-revision-reference" style={{ marginTop: "3mm", textAlign: "center" }}>مرجع جدول السداد: #{schedule.id} · نسخة {schedule.version}</p>
  </div></>;
}
