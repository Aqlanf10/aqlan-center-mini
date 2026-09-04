import { notFound } from "next/navigation";
import { getPlan, getSettingsSafe } from "@/lib/db";
import { formatMoney, isCurrency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { clinicDateString } from "@/lib/schedule";
import { buildInstallmentPlanAgreement } from "@/lib/plans";

export const dynamic = "force-dynamic";

/**
 * عقد واتفاقية خطة العلاج وجدول الأقساط — ورقة A4 رسمية.
 *
 * وثيقة ملزمة تُطبع للمريض ليوقع عليها عند اعتماد خطة التقويم أو الزراعة.
 * تفصّل الاتفاق المالي، مواعيد استحقاق كل قسط، والالتزامات السريرية.
 */
export default async function PlanAgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session || !canHandleMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const today = clinicDateString(new Date(), "Asia/Aden");
  const [plan, settings] = await Promise.all([getPlan(id, today), getSettingsSafe()]);
  if (!plan) notFound();

  const base = isCurrency(plan.baseCurrency) ? plan.baseCurrency : "YER";
  const agreement = buildInstallmentPlanAgreement({
    planId: plan.id,
    patientName: plan.patientName,
    patientPhone: plan.patientPhone,
    planTitle: plan.title,
    totalMinor: plan.totalMinor,
    baseCurrency: base,
    startDate: plan.startDate,
    note: plan.note,
    installments: plan.installments,
    paidMinor: plan.paidMinor,
  });

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4">
        <PrintHeader settings={settings} title="اتفاقية خطة العلاج وجدول الأقساط" />

        <div className="line">
          <span>رقم الخطة</span>
          <span className="num" dir="ltr">#{plan.id}</span>
        </div>
        <div className="line">
          <span>المريض</span>
          <span style={{ fontWeight: 700 }}>{agreement.patientName}</span>
        </div>
        {agreement.patientPhone ? (
          <div className="line">
            <span>رقم الهاتف</span>
            <span className="num" dir="ltr">{agreement.patientPhone}</span>
          </div>
        ) : null}
        <div className="line">
          <span>موضوع الخطة</span>
          <span style={{ fontWeight: 600 }}>{agreement.planTitle}</span>
        </div>
        <div className="line">
          <span>تاريخ بدء الخطة</span>
          <span>{friendlyDateLong(agreement.startDate)}</span>
        </div>

        <div className="rule" />

        <div style={{ margin: "4mm 0", background: "#f8fafc", padding: "3mm", borderRadius: "2mm", border: "1px solid #e2e8f0" }}>
          <div className="line line-strong" style={{ fontSize: "14pt" }}>
            <span>إجمالي تكلفة الخطة المتفق عليها</span>
            <span className="num">{formatMoney(agreement.totalMinor, base)}</span>
          </div>
          <div className="line" style={{ color: "#059669", fontWeight: 700 }}>
            <span>المسدد حتى تاريخه</span>
            <span className="num">{formatMoney(plan.progress.paidMinor, base)}</span>
          </div>
          <div className="line" style={{ color: "#b91c1c", fontWeight: 700 }}>
            <span>المتبقي من قيمة الخطة</span>
            <span className="num">{formatMoney(plan.progress.remainingMinor, base)}</span>
          </div>
        </div>

        <h3 style={{ fontSize: "11pt", fontWeight: 700, margin: "4mm 0 2mm" }}>
          جدول الأقساط والمواعيد الاستحقاقية ({agreement.installments.length} أقساط)
        </h3>

        {agreement.installments.length === 0 ? (
          <p style={{ textAlign: "center", color: "#64748b", margin: "4mm 0" }}>
            خطة بنود وإجراءات (تُفوتر وتسدد حسب الجلسات المنجزة).
          </p>
        ) : (
          <table className="items" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "center", width: "15%" }}>القسط</th>
                <th style={{ textAlign: "right", width: "35%" }}>تاريخ الاستحقاق</th>
                <th className="num" style={{ width: "30%" }}>المبلغ المستحق</th>
                <th style={{ textAlign: "center", width: "20%" }}>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {agreement.installments.map((inst) => (
                <tr key={inst.number} style={{ background: inst.paid ? "#f0fdf4" : "transparent" }}>
                  <td style={{ textAlign: "center", fontWeight: 700 }}>{inst.number}</td>
                  <td style={{ textAlign: "right" }}>{friendlyDateLong(inst.dueDate)}</td>
                  <td className="num">{formatMoney(inst.amountMinor, base)}</td>
                  <td style={{ textAlign: "center", fontSize: "9pt", fontWeight: 700, color: inst.paid ? "#15803d" : "#b45309" }}>
                    {inst.paid ? "مسدد ✓" : "مستحق"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="rule-light" style={{ margin: "4mm 0" }} />

        <h3 style={{ fontSize: "10pt", fontWeight: 700, margin: "2mm 0" }}>الشروط والالتزامات السريرية:</h3>
        <ol style={{ paddingRight: "5mm", margin: "2mm 0", fontSize: "8.5pt", lineHeight: "1.6", color: "#334155" }}>
          {agreement.terms.map((term, i) => (
            <li key={i} style={{ marginBottom: "1.5mm" }}>{term}</li>
          ))}
        </ol>

        {agreement.note ? (
          <p className="footer-note" style={{ fontSize: "8.5pt", margin: "2mm 0" }}>
            <strong>ملاحظات سريرية خاصة:</strong> {agreement.note}
          </p>
        ) : null}

        <div className="sign-row" style={{ marginTop: "8mm", display: "flex", justifyContent: "space-between" }}>
          <div style={{ textAlign: "center", width: "40%" }}>
            <p style={{ fontWeight: 700, fontSize: "10pt" }}>الطبيب المعالج / إدارة المركز</p>
            <div style={{ height: "15mm", borderBottom: "1px dashed #94a3b8" }} />
            <p style={{ fontSize: "8pt", color: "#64748b", marginTop: "1mm" }}>الختم والتوقيع</p>
          </div>
          <div style={{ textAlign: "center", width: "40%" }}>
            <p style={{ fontWeight: 700, fontSize: "10pt" }}>إقرار وموافقة المريض (أو ولي أمره)</p>
            <div style={{ height: "15mm", borderBottom: "1px dashed #94a3b8" }} />
            <p style={{ fontSize: "8pt", color: "#64748b", marginTop: "1mm" }}>التوقيع والاسم الثلاثي</p>
          </div>
        </div>
      </div>
    </>
  );
}
