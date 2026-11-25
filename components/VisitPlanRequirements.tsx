import { plannedItemBlock, type PlannedClinicalEvidence } from "./invoice-clinical-readiness";

export function VisitPlanRequirementsNote() {
  return <p className="mb-2 text-xs leading-relaxed text-slate-600" data-testid="plan-requirements-note">
    التنبيهات من قراءة الزيارة؛ اختيار البند أو غياب التنبيه لا يعني اكتمال شروطه. يتحقق الخادم مجددًا عند التوقيع.
  </p>;
}

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
  const status = statusLabels[item.status] ?? item.status ?? "غير متاحة";
  const financial = item.financialReviewRequired === true || item.billingStatus === "needs_financial_review"
    ? "مراجعة مالية" : item.origin === "invoice" && typeof item.financialReviewRequired !== "boolean"
      ? "المالية غير متحققة" : null;
  const consent = item.clinicalConsentRecorded === false ? "الموافقة غير مسجلة"
    : item.origin === "invoice" && item.clinicalConsentRecorded !== true ? "الموافقة غير معلومة" : null;
  const badges = [financial, consent, unmet.length > 0 ? "متطلبات اعتماد" : null].filter(Boolean);
  return <details className="mt-2 min-w-0 border-t border-slate-100 pt-1 text-[11px]" data-testid={`plan-requirements-${item.planItemId}`}>
    <summary className="min-h-8 cursor-pointer rounded text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy-600">
      <span className="ms-1 inline-flex max-w-full flex-wrap items-center gap-1.5 align-middle">
        <span>{status} · تفاصيل الشروط</span>
        {badges.map((badge) => <span key={badge} className="rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-900">{badge}</span>)}
      </span>
    </summary>
    <div className="mt-1 space-y-1 break-words ps-3">
      <p className="text-slate-600">حالة البند في المصدر: {status}</p>
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
      </div> : <p className="text-slate-500">لم تُرجع القراءة تنبيهات اعتماد؛ هذا لا يثبت اكتمال جميع الشروط.</p>}
      <p className="text-slate-500">تفاصيل البنود المرجعية وحالاتها غير متاحة هنا؛ الإلغاء أو بدء التنفيذ لا يعني اكتمال العلاج أو إذنًا سريريًا.</p>
    </div>
  </details>;
}
