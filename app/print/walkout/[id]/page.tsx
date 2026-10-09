import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getSettingsSafe, getVisitOwner, visitWalkout } from "@/lib/db";
import { CURRENCY_LABEL, formatMoney } from "@/lib/money";
import { friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { authorizeVisit } from "@/lib/operational-access";
import { requireSession } from "@/lib/session";
import { WALKOUT_CLASS_LABEL, adjustmentLabel, lineNeedsReview, walkoutNeedsReview, PREVIOUS_BALANCE_LABEL, PREVIOUS_BALANCE_NOTE } from "@/lib/walkout-presentation";
import { CURRENCIES } from "@/lib/money";
import { canSeeWalkout } from "@/lib/walkout-access";

export const dynamic = "force-dynamic";

/**
 * (CHAIR-1 Slice 5) ملخّص المغادرة — ورقةٌ صغيرة يأخذها المريض: عمل اليوم (وما شُمل بخطته)،
 * والفاتورة، وسندات اليوم، والرصيد بكل عملة، والموعد القادم. من بياناتٍ قائمة، لا حساب جديد.
 */
export default async function WalkoutPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) notFound();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const allowed = await authorizeVisit(session, id);
  if (!allowed.ok) notFound();
  const owner = await getVisitOwner(id);
  if (!(await canSeeWalkout(session, owner.patientId))) notFound();

  const [walkout, settings] = await Promise.all([visitWalkout(id), getSettingsSafe()]);
  if (!walkout) notFound();
  const day = clinicDateString(new Date(walkout.arrivedAt), CLINIC_TIME_ZONE);
  const financialReviewRequired = walkoutNeedsReview(walkout);

  return (
    <>
      <div className="no-print" style={{ marginBottom: "8px" }}><PrintButton /></div>
      <div className="sheet sheet-a5">
        <PrintHeader settings={settings} title="ملخّص الزيارة" compact />
        <div className="line"><span>المريض</span><span style={{ fontWeight: 700 }}>{walkout.patientName}</span></div>
        {walkout.patientNumber ? (
          <div className="line"><span>رقم الملف</span><span className="num" dir="ltr">{walkout.patientNumber}</span></div>
        ) : null}
        <div className="line"><span>التاريخ</span><span>{friendlyDateLong(day)}</span></div>
        {walkout.doctorName ? <div className="line"><span>الطبيب</span><span>{walkout.doctorName}</span></div> : null}

        <div className="rule" />
        <table className="items">
          <thead>
            <tr><th>عمل اليوم</th><th className="num">الكمية</th><th className="num">السعر</th></tr>
          </thead>
          <tbody>
            {walkout.orthoAdjustment ? (
              <tr><td>شدّة تقويم</td><td className="num">1</td><td>{adjustmentLabel(walkout.orthoAdjustment)}</td></tr>
            ) : null}
            {walkout.lines.length === 0 && !walkout.orthoAdjustment ? (
              <tr><td colSpan={3}>لا توجد إجراءات مسجلة في ملخص هذه الزيارة</td></tr>
            ) : null}
            {walkout.lines.map((line, index) => (
              <tr key={index}>
                <td>{line.description}{line.toothCode ? ` — سن ${line.toothCode}` : ""}</td>
                <td className="num" dir="ltr">{line.quantity}</td>
                <td className="num">{lineNeedsReview(line) ? "يحتاج مراجعة مالية — التغطية غير محسومة"
                  : line.billingClass === "NEW_BILLABLE" ? formatMoney(line.unitPriceMinor * line.quantity, line.currency) : WALKOUT_CLASS_LABEL[line.billingClass].text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {financialReviewRequired ? <p data-testid="walkout-print-financial-review" className="footer-note">
          توجد بنود تحتاج مراجعة مالية؛ لا يثبت هذا الملخص أنها مجانية أو مشمولة أو مستحقة للتحصيل.
          الفواتير والمدفوعات والأرصدة المثبتة أدناه حقائق مالية مستقلة عن هذه المراجعة.
        </p> : null}
        {walkout.treatmentDone ? <p className="footer-note">{walkout.treatmentDone}</p> : null}

        <div className="rule-light" />
        {walkout.invoice ? (
          <div className="line line-strong">
            <span>فاتورة اليوم ({walkout.invoice.number})</span>
            <span className="num">{formatMoney(walkout.invoice.netMinor, walkout.invoice.currency)}</span>
          </div>
        ) : <div className="line"><span>فاتورة اليوم</span><span>{financialReviewRequired ? "لا فاتورة جديدة للزيارة؛ توجد بنود تحتاج مراجعة مالية" : "لا رسوم على هذه الزيارة"}</span></div>}
        {walkout.payments.map((payment) => (
          <div className="line" key={payment.receiptNumber}>
            <span>{payment.kind === "refund" ? "مردود" : "مدفوع"} — سند {payment.receiptNumber}</span>
            <span className="num">{formatMoney(payment.amountMinor, payment.currency)}</span>
          </div>
        ))}
        {walkout.deferred ? <div className="line"><span>الدفع</span><span>مؤجَّل</span></div> : null}
        <p className="footer-note">{PREVIOUS_BALANCE_NOTE}</p>
        {CURRENCIES.filter((currency) => (walkout.checkout.previous[currency] ?? 0) !== 0).map((currency) => (
          <div className="line" key={`previous-${currency}`}>
            <span>{PREVIOUS_BALANCE_LABEL} ({CURRENCY_LABEL[currency]})</span>
            <span className="num">{formatMoney(walkout.checkout.previous[currency]!, currency)}</span>
          </div>
        ))}
        {walkout.balances.length === 0 ? (
          <div className="line"><span>الرصيد</span><span>لا رصيد مستحق</span></div>
        ) : walkout.balances.map((row) => (
          <div className="line" key={row.currency}>
            <span>{row.balanceMinor > 0 ? "الرصيد المستحق" : "رصيد دائن للمريض"} ({CURRENCY_LABEL[row.currency]})</span>
            <span className="num">{formatMoney(Math.abs(row.balanceMinor), row.currency)}</span>
          </div>
        ))}

        <div className="rule-light" />
        <div className="line">
          <span>الموعد القادم</span>
          <span>{walkout.nextAppointment
            ? `${friendlyDateLong(walkout.nextAppointment.date)} — ${friendlyTime(walkout.nextAppointment.time)}`
            : walkout.nextPlan ?? "يُحدَّد لاحقًا"}</span>
        </div>
        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
