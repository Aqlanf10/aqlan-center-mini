import { formatMoney, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { hasLegacyHistory, planConsentIsCurrent, type HistoricalPlanItem } from "./legacy-treatment-view";
import { LegacyPlanHistory } from "./LegacyPlanHistory";

interface HistoricalPrintPlan {
  id: number; title: string; patientName: string; totalMinor: number;
  consentAt: string | null; consentBy: string | null; consentNote: string | null;
  items: readonly (HistoricalPlanItem & { id: number; serviceName: string; toothCode: number | null; totalMinor: number })[];
}

/** Read-only history. Printing does not create consent, a new contract, debt or assessed clinical progress. */
export function LegacyPlanPrintSummary({ plan, currency }: { plan: HistoricalPrintPlan; currency: Currency }) {
  const currentConsent = planConsentIsCurrent(plan);
  const historicalItems = plan.items.filter(hasLegacyHistory);
  return (
    <section data-testid="legacy-plan-print-reference">
      <div className="line"><span>رقم الخطة</span><span dir="ltr">#{plan.id}</span></div>
      <div className="line"><span>المريض</span><span>{plan.patientName}</span></div>
      <div className="line"><span>موضوع الخطة</span><span>{plan.title}</span></div>
      <p style={{ fontWeight: 700, margin: "4mm 0" }}>مرجع تاريخي للقراءة فقط؛ لا ينشئ اتفاقًا جديدًا أو موافقة علاج أو مديونية جديدة.</p>
      <div className="line"><span>قيمة الخطة المتضمنة للتاريخ (ليست دَينًا)</span><span>{formatMoney(plan.totalMinor, currency)}</span></div>
      <p style={{ margin: "3mm 0" }}>المستحق الحالي يؤخذ من حساب المريض فقط. مبالغ الاتفاقات التاريخية لا تثبت المنجَز قبل النظام أو باقي العلاج سريريًّا.</p>
      <LegacyPlanHistory items={historicalItems} currency={currency} canSeeFinancial consented={currentConsent} />
      {plan.items.length > historicalItems.length ? (
        <p>تتضمن الخطة بنودًا أخرى؛ لا تُعد مبالغ التاريخ تقييمًا لتقدّم تلك البنود أو لباقي العمل.</p>
      ) : null}
      {plan.consentAt ? (
        <p data-testid="legacy-plan-print-consent" style={{ margin: "3mm 0" }}>
          {currentConsent ? "موافقة العلاج الحالية المسجّلة: " : "تاريخ موافقة محفوظ غير متحقق للموافقة الحالية: "}
          {friendlyDateLong(plan.consentAt.slice(0, 10))}
          {plan.consentBy ? ` · سجّلها ${plan.consentBy}` : ""}
          {plan.consentNote ? ` · ${plan.consentNote}` : ""}
        </p>
      ) : null}
      {!currentConsent ? <p>الموافقة الحالية غير متحققة. يلزم التحقق من التغطية وتوثيق الموافقة الفعلية قبل توقيع الزيارة؛ حفظ المسودة متاح.</p> : null}
    </section>
  );
}
