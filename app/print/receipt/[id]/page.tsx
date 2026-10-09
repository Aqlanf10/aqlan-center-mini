import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getPayment, getSettingsSafe, printCount } from "@/lib/db";
import { CURRENCY_LABEL, formatMoney, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { formatClinicTimestamp } from "@/lib/clinic-clock";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton, ReprintMark } from "@/components/PrintButton";
import { canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { readReceiptProvenance } from "@/lib/receipt-provenance-db";
import { receiptDocumentTitle } from "@/lib/receipt-provenance";
import { ReceiptProvenance } from "@/components/ReceiptProvenance";

export const dynamic = "force-dynamic";

/**
 * سند القبض — ربع ورقة A4.
 *
 * قرار المالك: «اريد السند يكون ربع ورقه اي فور… بحيث ما نخسر ورق كثير». وهو قرار
 * صحيح عمليًا: العيادة تطبع عشرات السندات يوميًا، وورقة كاملة لسطرين هدرٌ يُشترى
 * بالعملة الصعبة.
 *
 * والسند يحمل **العملة المدفوعة وسعر الصرف ومكافئها**: مريضٌ دفع مئة دولار يجب أن
 * يرى في ورقته أنه دفع مئة دولار، لا رقمًا بالريال لا يعرف من أين جاء.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  // الطبيب لا يرى السندات والفواتير: صفحة الطباعة بابٌ خلفي إلى المال لو تُركت
  // مفتوحة لكل من يملك جلسة.
  const session = await requireSession();
  if (!session || !canViewMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [payment, settings] = await Promise.all([getPayment(id), getSettingsSafe()]);
  const printed = await printCount("receipt", id);
  if (!payment) notFound();
  const provenance = (await readReceiptProvenance([payment.id]))[payment.id];

  // (TD-05) الأساس دستوري من الكود.
  const base = CLINIC_BASE_CURRENCY;
  // Receipt creation is its source instant, not a clinical signature or print time.
  const createdText = formatClinicTimestamp(payment.createdAt, CLINIC_TIME_ZONE);
  const isRefund = payment.kind === "refund";

  return (
    <>
      <PrintButton docType="receipt" docId={id} />
      <ReprintMark printed={printed > 0} />
      <div className="sheet sheet-a6">
        <PrintHeader settings={settings} title={receiptDocumentTitle(payment.kind, provenance)} compact />

        <div className="line">
          <span>رقم السند</span>
          <span className="num" dir="ltr">{payment.receiptNumber}</span>
        </div>
        <div className="line">
          <span>التاريخ</span>
          <time dateTime={payment.createdAt}><bdi>{createdText}</bdi></time>
        </div>
        <div className="rule-light" />

        <div className="line">
          <span>{isRefund ? "المريض" : "استلمنا من"}</span>
          <span style={{ fontWeight: 700 }}>{payment.patientName}</span>
        </div>
        {payment.invoiceId ? (
          <div className="line">
            <span>على فاتورة</span>
            <span className="num" dir="ltr">#{payment.invoiceId}</span>
          </div>
        ) : null}
        <div className="line">
          <span>طريقة الدفع</span>
          <span>{payment.method === "transfer" ? "تحويل" : "نقدًا"}</span>
        </div>

        <p className="amount-box">
          {formatMoney(payment.amountMinor, payment.currency)}
        </p>

        {payment.currency !== base ? (
          <>
            <div className="line">
              <span>العملة</span>
              <span>{CURRENCY_LABEL[payment.currency]}</span>
            </div>
            <div className="line">
              <span>{isRefund ? "سعر الصرف المسجّل" : "سعر الصرف يوم الدفع"}</span>
              <span className="num" dir="ltr">{payment.exchangeRate}</span>
            </div>
            <div className="line line-strong">
              <span>المكافئ</span>
              <span>{formatMoney(payment.baseAmountMinor, base)}</span>
            </div>
          </>
        ) : null}

        <ReceiptProvenance paymentId={payment.id} currency={payment.currency} provenance={provenance} compact />

        {payment.note ? (
          <>
            <div className="rule-light" />
            <p className="footer-note">{payment.note}</p>
          </>
        ) : null}

        <div className="sign-row">
          <span>{isRefund ? "سجّله" : "المستلم"}: {payment.createdBy ?? "—"}</span>
          <span>التوقيع: ................</span>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
