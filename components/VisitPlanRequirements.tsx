import { plannedItemBlock, type PlannedClinicalEvidence } from "./invoice-clinical-readiness";

/** Read evidence only. This component must never grant clearance or compute signature authority. */
export function VisitPlanRequirements({ item }: { item?: PlannedClinicalEvidence & { status: string; unmetRequirements?: string[] } }) {
  if (!item) return <p className="mt-2 text-[11px] text-slate-500" data-testid="plan-requirements-unknown">
    تفاصيل هذا البند وشروطه غير متاحة في قراءة الزيارة الحالية؛ لا يمكن إثبات اكتمالها هنا.
  </p>;
  const block = plannedItemBlock(item);
  const unmet = Array.isArray(item.unmetRequirements) ? item.unmetRequirements.filter((line) => typeof line === "string") : [];
  const statusLabels: Record<string, string> = {
    planned: "مخطط", pending: "بانتظار التنفيذ", in_progress: "قيد التنفيذ", done: "مكتمل", cancelled: "ملغى",
  };
  return <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-[11px]" data-testid={`plan-requirements-${item.planItemId}`}>
    <p className="text-slate-600">حالة البند في المصدر: {statusLabels[item.status] ?? item.status ?? "غير متاحة"}</p>
    {item.origin === "invoice" || typeof item.clinicalConsentRecorded === "boolean" ? <p className="text-slate-600">
      الموافقة السريرية في المصدر: {item.clinicalConsentRecorded === true ? "مسجلة" : item.clinicalConsentRecorded === false ? "غير مسجلة" : "غير معلومة"}
    </p> : null}
    {item.origin === "invoice" || typeof item.financialReviewRequired === "boolean" ? <p className="text-slate-600">
      المراجعة المالية: {item.financialReviewRequired === true ? "مطلوبة" : item.financialReviewRequired === false ? "غير مطلوبة بحسب القراءة" : "تعذّر التحقق"}
    </p> : null}
    {block ? <p role="status" data-testid={`planned-item-blocked-${item.planItemId}`} className="font-bold text-amber-800">{block}</p> : null}
    {unmet.length > 0 ? <div className="text-amber-800">
      <p className="font-bold">تنبيهات الاعتماد من قراءة الزيارة:</p>
      <ul className="list-inside list-disc">{unmet.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>
      <p>اختيار البند لا يستوفي هذه المتطلبات. يتحقق الخادم مجددًا عند التوقيع.</p>
    </div> : <p className="text-slate-500">لم تُرجع القراءة تنبيهات اعتماد؛ هذا لا يثبت اكتمال جميع الشروط.</p>}
    <p className="text-slate-500">تفاصيل البنود المرجعية وحالاتها غير متاحة هنا؛ الإلغاء أو بدء التنفيذ لا يعني اكتمال العلاج أو إذنًا سريريًا.</p>
  </div>;
}
