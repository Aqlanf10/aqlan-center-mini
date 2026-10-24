import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getPlan, getSettingsSafe } from "@/lib/db";
import { formatMoney, isCurrency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader } from "@/components/PrintHeader";
import { LegacyPlanPrintSummary } from "@/components/LegacyPlanPrintSummary";
import { hasLegacyHistory } from "@/components/legacy-treatment-view";
import { PrintButton } from "@/components/PrintButton";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { clinicDateString } from "@/lib/schedule";
import { buildInstallmentPlanAgreement } from "@/lib/plans";
import { DebtRepaymentAgreementPrint } from "@/components/DebtRepaymentAgreementPrint";

export const dynamic = "force-dynamic";

/**
 * عقد واتفاقية خطة العلاج وجدول الأقساط — ورقة A4 رسمية.
 *
 * وثيقة ملزمة تُطبع للمريض ليوقع عليها عند اعتماد خطة التقويم أو الزراعة.
 * تفصّل الاتفاق المالي، مواعيد استحقاق كل قسط، والالتزامات السريرية.
 */
export default async function PlanAgreementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ source?: string; version?: string }> }) {
  const session = await requireSession();
  if (!session || !canHandleMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const query = await searchParams;
  if (query?.source === "debt-repayment") return <DebtRepaymentAgreementPrint id={id} version={Number(query.version)} today={today} />;
  if (query?.source !== undefined || query?.version !== undefined) notFound();
  const [plan, settings] = await Promise.all([getPlan(id, today), getSettingsSafe()]);
  if (!plan) notFound();

  const base = isCurrency(plan.baseCurrency) ? plan.baseCurrency : "YER";
  const currentFinancial = plan.approvedAgreement?.available && plan.approvedAgreement.currency === base ? plan.approvedAgreement : null;
  const approvalUnavailable = !!plan.approvedAgreement && !currentFinancial;
  const amended = !!plan.approvedAgreement?.deltaInvoiceIds?.length;
  const approvedSummary = currentFinancial ? <section data-testid="approved-agreement-print">
          <p>التزام مالي معتمد — المصدر: {currentFinancial.invoiceId ? `فاتورة #${currentFinancial.invoiceId}` : `رصيد افتتاحي ${base}`}</p>
          {currentFinancial.deltaInvoiceIds?.length ? <p>فواتير فروق التعديل: {currentFinancial.deltaInvoiceIds.map(id => `#${id}`).join("، ")}. المبلغ الحالي يشمل أصل الاتفاق وهذه الفروق فقط.</p> : null}
          <div className="line"><span>كامل المتبقي</span><span>{formatMoney(currentFinancial.remainingMinor,base)}</span></div>
          <div className="line"><span>المستحق حتى اليوم</span><span>{formatMoney(currentFinancial.dueNowMinor,base)}</span></div>
        </section> : null;
  if (approvalUnavailable) return <><PrintButton /><div className="sheet sheet-a4">
    <PrintHeader settings={settings} title="مراجعة مصدر اتفاق العلاج" />
    <p>{plan.patientName} — {plan.title}</p>
    <p role="alert">الرصيد الحالي غير متاح؛ يلزم مراجعة مصدر الاتفاق. لا تثبت هذه الورقة مبلغًا مستحقًا أو مسدّدًا.</p>
  </div></>;
  // Historical provenance cannot become a new collectible plan contract or invented remaining work.
  // Preserve the ordinary agreement below exactly; history prints as an explicitly read-only reference.
  if (plan.items.some(hasLegacyHistory)) return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4">
        <PrintHeader settings={settings} title="مرجع خطة تشمل علاجًا تاريخيًّا" />
        <LegacyPlanPrintSummary plan={plan} currency={base} />
        {approvedSummary}
      </div>
    </>
  );
  if(plan.invoiceFinancial) return <><PrintButton /><div className="sheet sheet-a4">
    <PrintHeader settings={settings} title="سداد الفواتير المرتبطة بخطة العلاج" />
    <p>{plan.patientName} — {plan.title}</p>
    <p>{plan.invoiceFinancial.message ?? "قراءة من الفواتير وجدول سداد الدين القائم؛ لا تنشئ هذه الورقة التزامًا جديدًا."}</p>
    {plan.invoiceFinancial.kind === "invoice_backed" ? <>
      <p>أصل الفواتير: {formatMoney(plan.invoiceFinancial.progress.totalMinor,base)}</p>
      <p>المسدد: {formatMoney(plan.invoiceFinancial.paidMinor,base)} · المتبقي: {formatMoney(plan.invoiceFinancial.remainingMinor,base)}</p>
      {plan.invoiceFinancial.schedules.filter(schedule=>schedule.status === "active").map(schedule=><section key={schedule.id}>
        <h3>جدول سداد الفاتورة #{schedule.target.invoiceId} — النسخة {schedule.version}</h3>
        {schedule.requiresReview ? <p>يحتاج جدول السداد إلى مراجعة مصدر الدين.</p> : null}
        {!schedule.requiresReview && schedule.progress?.rows.map((row,index)=><p data-testid="verified-plan-schedule-row" key={index}>{friendlyDateLong(row.dueDate)} · {formatMoney(row.amountMinor,base)} · المتبقي {formatMoney(row.remainingMinor,base)}</p>)}
      </section>)}
    </> : null}
  </div></>;
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
    paidMinor: plan.approvedAgreement?.originalPaidMinor ?? plan.paidMinor,
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

        <div data-testid="current-plan-financial-summary" style={{ margin: "4mm 0", background: "#f8fafc", padding: "3mm", borderRadius: "2mm", border: "1px solid #e2e8f0" }}>
          <div className="line line-strong" style={{ fontSize: "14pt" }}>
            <span>{currentFinancial ? "إجمالي الاتفاق المالي الحالي" : "إجمالي تكلفة الخطة المتفق عليها"}</span>
            <span className="num">{formatMoney(currentFinancial?.totalMinor ?? agreement.totalMinor, base)}</span>
          </div>
          <div className="line" style={{ color: "#059669", fontWeight: 700 }}>
            <span>المسدد حتى تاريخه</span>
            <span className="num">{formatMoney(currentFinancial?.paidMinor ?? plan.progress.paidMinor, base)}</span>
          </div>
          <div className="line" style={{ color: "#b91c1c", fontWeight: 700 }}>
            <span>المتبقي من قيمة الخطة</span>
            <span className="num">{formatMoney(currentFinancial?.remainingMinor ?? plan.progress.remainingMinor, base)}</span>
          </div>
        </div>

        {amended && currentFinancial?.originalTotalMinor !== undefined ? <p data-testid="original-plan-agreement">قيمة الاتفاق الأصلي قبل التعديلات: {formatMoney(currentFinancial.originalTotalMinor, base)}. الجدول والبنود الأصلية محفوظة كتاريخ؛ فرق التعديل موثق بفواتير مستقلة ولا يغيّر الجدول الأصلي.</p> : null}
        {approvedSummary}
        <h3 style={{ fontSize: "11pt", fontWeight: 700, margin: "4mm 0 2mm" }}>
          {amended ? "جدول الأقساط الأصلي والمواعيد الاستحقاقية" : "جدول الأقساط والمواعيد الاستحقاقية"} ({agreement.installments.length} أقساط)
        </h3>

        {agreement.installments.length === 0 ? (
          <p style={{ textAlign: "center", color: "#64748b", margin: "4mm 0" }}>
            {plan.approvedAgreement ? "كامل الالتزام مستحق؛ لا يوجد جدول أقساط مؤجلة." : "خطة بنود وإجراءات (تُفوتر وتسدد حسب الجلسات المنجزة)."}
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
