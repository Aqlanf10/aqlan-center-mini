import { debtInstallmentPrintStatus } from "@/lib/debt-installment-print-status";
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
  return <><PrintButton /><div className="sheet sheet-a4 repayment-contract" data-testid="saved-installment-contract" dir="rtl">
    <PrintHeader settings={settings} title="اتفاقية سداد وجدول الأقساط" />
    <div className="line"><span>مرجع الاتفاق</span><strong>{source.invoice_number ? `فاتورة ${source.invoice_number}` : `الرصيد السابق ${currency}`} · ترتيب #{schedule.id} · النسخة {schedule.version}</strong></div>
    <div className="line"><span>المريض</span><strong>{source.full_name}</strong></div>
    <div className="line"><span>رقم الملف</span><span>{source.patient_number}</span></div>
    {source.phone ? <div className="line"><span>رقم الهاتف</span><span dir="ltr">{source.phone}</span></div> : null}
    <div className="line"><span>حالة السداد بتاريخ</span><span>{friendlyDateLong(today)}</span></div>
    <div className="line"><span>عملة الاتفاق</span><strong>{currency}</strong></div>
    <div className="rule" />
    <section className="repayment-summary" aria-label="ملخص مصدر الدين">
    <div className="line line-strong"><span>{source.invoice_number ? "إجمالي الفاتورة" : "قيمة الرصيد السابق"}</span><span>{formatMoney(schedule.principalMinor, currency)}</span></div>
    <div className="line repayment-paid"><span>صافي المسدد فعليًا حتى تاريخه</span><span>{formatMoney(schedule.collectedMinor, currency)}</span></div>
    <div className="line repayment-balance"><span>متبقي الدين الفعلي</span><strong>{formatMoney(schedule.remainingMinor, currency)}</strong></div>
    </section>
    <h3>أساس هذه النسخة من الجدول</h3>
    <div className="line"><span>المبلغ المتبقي الذي جرى جدولته عند الاعتماد</span><span>{formatMoney(schedule.revisionPrincipalMinor, currency)}</span></div>
    <div className="line"><span>الدفعة الأولى المقترحة ضمن الجدول</span><span>{formatMoney(proposed, currency)}</span></div>
    <div className="line"><span>المتبقي المجدول بعد المقدمة المقترحة</span><span>{formatMoney(schedule.revisionPrincipalMinor - proposed, currency)}</span></div>
    <p className="footer-note">المقدمة المقترحة موعد سداد وليست سند قبض. المسدد الفعلي أعلاه من السندات والتسويات المسجلة فقط.</p>
    <h3>جدول الأقساط وحالة السداد</h3>
    <p className="footer-note" id="repayment-allocation-note">المحصّل في صفوف الجدول يخص السداد منذ اعتماد هذه النسخة فقط، وهو جزء من صافي المسدد أعلاه، وليس مبلغًا إضافيًا. السداد السابق للاعتماد لا يُضاف مرة أخرى إلى الجدول.</p>
    <div className="repayment-table-wrap"><table className="items repayment-table" aria-describedby="repayment-allocation-note"><thead><tr><th scope="col">الدفعة</th><th scope="col">تاريخ الاستحقاق</th><th scope="col">المبلغ</th><th scope="col">محصّل ضمن النسخة</th><th scope="col">المتبقي</th><th scope="col">حالة السداد</th></tr></thead>
      <tbody>{schedule.progress!.rows.map((row, index) => {
        const status = debtInstallmentPrintStatus(row, today);
        return <tr key={index} data-payment-status={status.tone}>
          <th scope="row">{row.kind === "down_payment" ? "دفعة أولى مجدولة" : `قسط ${index + 1 - (schedule.terms.installments[0]?.kind === "down_payment" ? 1 : 0)}`}</th>
          <td><time dateTime={row.dueDate}>{friendlyDateLong(row.dueDate)}</time></td><td>{formatMoney(row.amountMinor, currency)}</td><td>{formatMoney(row.settledMinor, currency)}</td><td>{formatMoney(row.remainingMinor, currency)}</td>
          <td><span className={`repayment-status repayment-status-${status.tone}`}>{status.label}</span></td>
        </tr>;
      })}</tbody></table></div>
    <div className="rule" /><h3>الشروط والالتزامات السريرية:</h3>
    <ol>{STANDARD_PLAN_TERMS.map((term, index) => <li key={index}>{term}</li>)}</ol>
    <div className="sign-row" style={{ marginTop: "8mm", display: "flex", justifyContent: "space-between" }}>
      <div style={{ width: "40%", textAlign: "center" }}><strong>الطبيب المعالج / إدارة المركز</strong><div style={{ height: "15mm", borderBottom: "1px dashed #94a3b8" }} />الختم والتوقيع</div>
      <div style={{ width: "40%", textAlign: "center" }}><strong>إقرار وموافقة المريض (أو ولي أمره)</strong><div style={{ height: "15mm", borderBottom: "1px dashed #94a3b8" }} />التوقيع والاسم الثلاثي</div>
    </div>
  </div></>;
}
