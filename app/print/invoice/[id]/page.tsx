import { notFound } from "next/navigation";
import { getInvoice, getPatient, getSettingsSafe, printCount } from "@/lib/db";
import { formatMoney, isCurrency } from "@/lib/money";
import { friendlyDateLong, invoiceWhatsAppSummaryText, toWhatsAppNumber, whatsAppDirectLink } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton, ReprintMark } from "@/components/PrintButton";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** الفاتورة — ورقة A4 كاملة لأنها تحمل بنودًا وقد تُحفظ في ملف المريض. */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  // الطبيب لا يرى السندات والفواتير: صفحة الطباعة بابٌ خلفي إلى المال لو تُركت
  // مفتوحة لكل من يملك جلسة.
  const session = await requireSession();
  if (!session || !canHandleMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [invoice, settings] = await Promise.all([getInvoice(id), getSettingsSafe()]);
  const printed = await printCount("invoice", id);
  if (!invoice) notFound();

  const patient = await getPatient(invoice.patientId);

  const base = isCurrency(invoice.baseCurrency) ? invoice.baseCurrency : "YER";
  const net = Math.max(0, invoice.totalMinor - invoice.discountMinor);
  const waNumber = patient?.phone ? toWhatsAppNumber(patient.phone) : null;
  const waText = invoiceWhatsAppSummaryText({
    patientName: invoice.patientName,
    invoiceNumber: invoice.invoiceNumber,
    netAmountText: formatMoney(net, base),
    clinicName: settings["clinic.name"],
    clinicPhone: settings["clinic.phone"],
  });

  return (
    <>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "flex-start", marginBottom: "8px" }} className="no-print">
        <PrintButton docType="invoice" docId={id} />
        {waNumber && whatsAppDirectLink(waNumber, waText) ? (
          <a
            href={whatsAppDirectLink(waNumber, waText) ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#16a34a",
              color: "#ffffff",
              padding: "6px 14px",
              borderRadius: "10px",
              fontSize: "12px",
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            📲 إرسال الفاتورة عبر واتساب
          </a>
        ) : null}
      </div>
      <ReprintMark printed={printed > 0} />
      <div className="sheet sheet-a4">
        <PrintHeader settings={settings} title="فاتورة" />

        <div className="line">
          <span>رقم الفاتورة</span>
          <span className="num" dir="ltr">{invoice.invoiceNumber}</span>
        </div>
        <div className="line">
          <span>المريض</span>
          <span style={{ fontWeight: 700 }}>{invoice.patientName}</span>
        </div>
        <div className="line">
          <span>التاريخ</span>
          <span>{friendlyDateLong(invoice.createdAt.slice(0, 10))}</span>
        </div>
        {invoice.status === "cancelled" ? (
          <p className="amount-box" style={{ borderStyle: "dashed" }}>ملغاة</p>
        ) : null}

        <div className="rule" />

        <table className="items">
          <thead>
            <tr>
              <th>البند</th>
              <th className="num">الكمية</th>
              <th className="num">السعر</th>
              <th className="num">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item) => (
              <tr key={item.id}>
                <td>{item.description}</td>
                <td className="num" dir="ltr">{item.quantity}</td>
                <td className="num">{formatMoney(item.unitPriceMinor, base)}</td>
                <td className="num">{formatMoney(item.totalMinor, base)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: "4mm" }}>
          <div className="line">
            <span>الإجمالي قبل الخصم</span>
            <span className="num">{formatMoney(invoice.totalMinor, base)}</span>
          </div>
          {invoice.discountMinor > 0 ? (
            <div className="line">
              <span>الخصم</span>
              <span className="num">− {formatMoney(invoice.discountMinor, base)}</span>
            </div>
          ) : null}
          <div className="line line-strong">
            <span>الصافي المستحق</span>
            <span className="num">{formatMoney(net, base)}</span>
          </div>
        </div>

        {invoice.note ? (
          <>
            <div className="rule-light" />
            <p className="footer-note">{invoice.note}</p>
          </>
        ) : null}

        <div className="sign-row">
          <span>المحاسب: ................</span>
          <span>المريض: ................</span>
        </div>

        <div style={{ marginTop: "6mm", padding: "3mm", border: "1px solid #cbd5e1", borderRadius: "2mm", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f8fafc" }}>
          <div style={{ fontSize: "8pt", color: "#475569" }}>
            <p style={{ fontWeight: 700, color: "#1e293b", marginBottom: "1mm" }}>فاتورة علاجية وضريبية معتمدة</p>
            <p>السجل / الرقم الضريبي: {(settings as Record<string, string>)["clinic.tax_number"] || (settings as Record<string, string>)["clinic.cr_number"] || "سجل طبي معتمد"}</p>
            <p>رمز الفاتورة: {invoice.invoiceNumber}-{id}</p>
          </div>
          <div style={{ textAlign: "center", border: "1px solid #94a3b8", padding: "2mm 3mm", background: "#ffffff", borderRadius: "1.5mm", fontSize: "7pt", fontFamily: "monospace" }}>
            ✓ E-INVOICE VERIFIED
            <br />
            <span style={{ fontSize: "6pt", color: "#64748b" }}>نظام الفوترة الإلكتروني</span>
          </div>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
