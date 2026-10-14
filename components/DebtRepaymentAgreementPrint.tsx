import { notFound } from "next/navigation";
import { readSavedRepaymentAgreement } from "@/lib/debt-repayment-agreement-db";
import { formatMoney } from "@/lib/money";
import { STANDARD_PLAN_TERMS } from "@/lib/plans";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader } from "./PrintHeader";
import { PrintButton } from "./PrintButton";

export async function DebtRepaymentAgreementPrint({ id, version, today }: { id: number; version: number; today: string }) {
  const agreement = await readSavedRepaymentAgreement(id, version, today);
  if (!agreement) notFound();
  const { source, schedule, settings } = agreement;
  const currency = schedule.target.currency;
  const proposed = schedule.terms.installments.find(row => row.kind === "down_payment")?.amountMinor ?? 0;
  return <><PrintButton /><div className="sheet sheet-a4" data-testid="saved-installment-contract" dir="rtl">
    <PrintHeader settings={settings} title="اتفاقية خطة العلاج وجدول الأقساط" />
    <div className="line"><span>مرجع الاتفاق</span><strong>{source.invoice_number ? `فاتورة ${source.invoice_number}` : `الرصيد السابق ${currency}`} · ترتيب #{schedule.id} · النسخة {schedule.version}</strong></div>
    <div className="line"><span>المريض</span><strong>{source.full_name}</strong></div>
    <div className="line"><span>رقم الملف</span><span>{source.patient_number}</span></div>
    {source.phone ? <div className="line"><span>رقم الهاتف</span><span dir="ltr">{source.phone}</span></div> : null}
    <div className="line"><span>عملة الاتفاق</span><strong>{currency}</strong></div>
    <div className="rule" />
    <div className="line line-strong"><span>قيمة مصدر الدين</span><span>{formatMoney(schedule.principalMinor, currency)}</span></div>
    <div className="line"><span>صافي المسدد فعليًا حتى تاريخه</span><span>{formatMoney(schedule.collectedMinor, currency)}</span></div>
    <div className="line"><span>متبقي الدين الفعلي</span><strong>{formatMoney(schedule.remainingMinor, currency)}</strong></div>
    <div className="line"><span>قيمة الجدول عند اعتماد النسخة</span><span>{formatMoney(schedule.revisionPrincipalMinor, currency)}</span></div>
    <div className="line"><span>الدفعة الأولى المقترحة ضمن الجدول</span><span>{formatMoney(proposed, currency)}</span></div>
    <div className="line"><span>المتبقي المجدول بعد المقدمة المقترحة</span><span>{formatMoney(schedule.revisionPrincipalMinor - proposed, currency)}</span></div>
    <p className="footer-note">المقدمة المقترحة موعد سداد وليست سند قبض. المسدد الفعلي أعلاه من السندات والتسويات المسجلة فقط.</p>
    <h3>جدول الأقساط والمواعيد الاستحقاقية</h3>
    <table className="items"><thead><tr><th>الدفعة</th><th>تاريخ الاستحقاق</th><th>المبلغ</th><th>محصّل فعليًا</th><th>المتبقي</th></tr></thead>
      <tbody>{schedule.progress!.rows.map((row, index) => <tr key={index}><td>{row.kind === "down_payment" ? "مقدمة مقترحة" : `قسط ${index + 1}`}</td>
        <td>{friendlyDateLong(row.dueDate)}</td><td>{formatMoney(row.amountMinor, currency)}</td><td>{formatMoney(row.settledMinor, currency)}</td><td>{formatMoney(row.remainingMinor, currency)}</td></tr>)}</tbody></table>
    <div className="rule" /><h3>الشروط والالتزامات السريرية:</h3>
    <ol>{STANDARD_PLAN_TERMS.map((term, index) => <li key={index}>{term}</li>)}</ol>
    <div className="sign-row" style={{ marginTop: "8mm", display: "flex", justifyContent: "space-between" }}>
      <div style={{ width: "40%", textAlign: "center" }}><strong>الطبيب المعالج / إدارة المركز</strong><div style={{ height: "15mm", borderBottom: "1px dashed #94a3b8" }} />الختم والتوقيع</div>
      <div style={{ width: "40%", textAlign: "center" }}><strong>إقرار وموافقة المريض (أو ولي أمره)</strong><div style={{ height: "15mm", borderBottom: "1px dashed #94a3b8" }} />التوقيع والاسم الثلاثي</div>
    </div>
  </div></>;
}
