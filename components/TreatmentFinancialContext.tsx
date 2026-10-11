"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney, type Currency } from "@/lib/money";
import type { ClinicalNavigationContext } from "@/lib/patient-navigation";
import type { FinancialReferenceReason, TreatmentFinancialContext as FinancialContext } from "@/lib/treatment-financial-context";
import { isTreatmentFinancialContext } from "@/lib/treatment-financial-context-validation";

const REASON: Record<FinancialReferenceReason, string> = {
  financial_review_required: "السجل يحتاج مراجعة مالية",
  invoice_reference_missing: "مرجع فاتورة غير محلول",
  invoice_lineage_unresolved: "سلسلة بند الفاتورة تحتاج مراجعة",
  legacy_coverage_unresolved: "نطاق الاتفاق التاريخي غير محسوم",
  legacy_agreement_void: "يوجد اتفاق تاريخي مُبطل محفوظ للمراجعة",
  legacy_agreement_missing: "مرجع الاتفاق التاريخي غير محلول",
  opening_reference_missing: "مرجع الرصيد الافتتاحي غير محلول",
  opening_allocation_unavailable: "تحصيل الرصيد السابق غير موزع على الاتفاقات",
  multiple_financial_sources: "توجد مراجع مالية متعددة تحتاج مراجعة",
  package_coverage_unspecified: "المشمول والإضافي في باقة التقويم غير محددين بهذا المرجع",
  item_settlement_allocation_unavailable: "السندات تخص المستند؛ لا يوجد توزيع مثبت على هذا البند",
  invoice_item_identity_conflict: "هوية بند الفاتورة تتعارض مع مرجع مصدره",
  installment_schedule_missing: "طريقة أقساط بلا جدول سداد أو مستندات أقساط مثبتة",
};

export interface TreatmentFinancialContextProps {
  patientId: number;
  /** Parent role gate is required; the server independently applies canViewMoney. */
  canView: boolean;
  /** Non-secret principal/role authority revision; changes fence same-role session transitions too. */
  authorityKey: string;
  planId?: number | null;
  planItemId?: number | null;
  clinicalCaseId?: number | null;
  orthoCaseId?: number | null;
  onOpenClinicalContext?: (context: ClinicalNavigationContext) => void;
}

/** Shared, read-only treatment/account view. No collection or package decision is inferred here. */
export default function TreatmentFinancialContext({
  patientId, canView, authorityKey, planId, planItemId, clinicalCaseId, orthoCaseId, onOpenClinicalContext,
}: TreatmentFinancialContextProps) {
  const [reload, setReload] = useState(0);
  const key = JSON.stringify([authorityKey, patientId, planId ?? null, planItemId ?? null, clinicalCaseId ?? null, orthoCaseId ?? null, reload]);
  // Object identity prevents A -> B -> A from reusing an earlier accepted A snapshot.
  // Capability loss/regrant gets a new generation even when the principal/key strings repeat.
  const owner = useMemo(() => ({ key, canView }), [key, canView]);
  const valid = typeof authorityKey === "string" && authorityKey.length > 0 && Number.isSafeInteger(patientId) && patientId > 0
    && [planId, planItemId, clinicalCaseId, orthoCaseId].every((id) => id == null || Number.isSafeInteger(id) && id > 0);
  const [state, setState] = useState<{ owner: typeof owner; data: FinancialContext | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!canView || !valid) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/treatment-financial-context`, {
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("تعذّر تحميل المرجع المالي أو لا توجد صلاحية لعرضه.");
        const data: unknown = await response.json();
        if (!isTreatmentFinancialContext(data, patientId)) throw new Error("المرجع المالي غير مكتمل أو لا يطابق المريض.");
        if (!controller.signal.aborted) setState({ owner, data, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setState({ owner, data: null,
          error: error instanceof Error ? error.message : "تعذّر تحميل المرجع المالي." });
      }
    })();
    return () => controller.abort();
  }, [canView, valid, patientId, owner]);

  if (!canView) return null;
  if (!valid) return <p role="alert" className="text-sm text-rose-700">هوية العلاج غير صالحة؛ أعد اختيار البند المقصود.</p>;
  if (state?.owner !== owner) return <p role="status" className="text-sm text-slate-500">جارٍ التحقق من المراجع المالية…</p>;
  if (!state.data) return <div role="alert" className="space-y-2 text-sm text-rose-700">
    <p>{state.error}</p><button type="button" className="underline" onClick={() => setReload((value) => value + 1)}>إعادة المحاولة</button>
  </div>;
  const data = state.data;
  // AND all selected identities. Never broaden a stale/mismatched deep link to another episode.
  const references = data.references.filter((reference) => (planId == null || reference.planId === planId)
    && (planItemId == null || reference.planItemId === planItemId)
    && (clinicalCaseId == null || reference.clinicalCaseId === clinicalCaseId)
    && (orthoCaseId == null || reference.orthoCaseId === orthoCaseId));
  const documentIds = new Set(references.flatMap((reference) => [...reference.invoiceIds, ...reference.installment.planDocumentIds]));
  const documents = data.documents.filter((document) => documentIds.has(document.invoiceId));
  const currencies = (["YER", "SAR", "USD"] as Currency[]).filter((currency) => {
    const position = data.accountPositions[currency];
    return position && (position.billedMinor !== 0 || position.collectedMinor !== 0 || position.openingMinor !== 0 || position.dueMinor !== 0);
  });
  return <section aria-label="المراجع المالية للعلاج" dir="rtl" className="min-w-0 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-slate-800">الخطة والمرجع المالي</h3>
      <button type="button" className="text-xs text-sky-700 underline" onClick={() => setReload((value) => value + 1)}>تحديث</button>
    </div>
    {!references.length && <p role="status" className="text-amber-800">لم يُثبت بند علاج يطابق جميع الهويات المحددة. لا تُعدّ خطة أقساط المريض وحدها تغطية لهذه الحالة.</p>}
    {references.map((reference) => <article key={reference.planItemId} className="min-w-0 space-y-2 rounded-lg border bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong>خطة #{reference.planId} · بند #{reference.planItemId}</strong>
        {reference.clinicalCaseId !== null && <span>حالة #{reference.clinicalCaseId}</span>}
        {reference.orthoCaseId !== null && <span>تقويم #{reference.orthoCaseId}</span>}
        {onOpenClinicalContext && reference.clinicalCaseId !== null && <button type="button" className="text-sky-700 underline"
          onClick={() => onOpenClinicalContext({ patientId, planId: reference.planId, planItemId: reference.planItemId,
            clinicalCaseId: reference.clinicalCaseId ?? undefined, orthoCaseId: reference.orthoCaseId ?? undefined })}>فتح الحالة المحددة</button>}
      </div>
      <p className="text-slate-600">قيمة الخطة السريرية: {formatMoney(reference.clinicalPlanValue.amountMinor, reference.clinicalPlanValue.currency)}. هذه القيمة وتقدم الجلسات لا يحددان الدين.</p>
      {reference.invoiceLines.map((line) => <p key={line.invoiceLineId} className="break-words">
        فاتورة #{line.invoiceId} · سطر #{line.invoiceLineId} · قيمة السطر قبل خصم المستند: {formatMoney(line.grossMinor, line.currency)}
      </p>)}
      {reference.historicalAgreements.map((agreement) => <div key={agreement.id} className="space-y-1 rounded bg-amber-50 p-2">
        <p className="font-medium">اتفاق تاريخي #{agreement.id}{agreement.status === "void" ? " · مُبطل" : ""} · حتى {agreement.historicalAsOf}</p>
        <p>المتفق: {formatMoney(agreement.agreedMinor, agreement.currency)} · المدفوع قبل النظام: {formatMoney(agreement.previouslyPaidMinor, agreement.currency)}</p>
        <p>المتبقي عند التسجيل: {formatMoney(agreement.remainingAtRegistrationMinor, agreement.currency)}</p>
        <p className="text-xs">المتبقي الحالي يُعرض في رصيد المريض بهذه العملة أدناه؛ لا يُنسب تحصيل الرصيد المشترك إلى اتفاق بعينه دون تخصيص مثبت.</p>
      </div>)}
      {reference.installment.mode === "historical_invoice_on_collection" && <p className="text-amber-800">
        مسار أقساط قائم يصدر الفواتير عند التحصيل. يلزم الحفاظ على تاريخه؛ لا تُنشأ فوقه فاتورة بكامل الاتفاق.
        {reference.installment.collectionRequiresFinancialReview ? " تحصيل قسط جديد عبر هذا المسار محجوب لوجود مرجع مالي سابق في الخطة." : ""}
      </p>}
      {!!reference.unresolvedReasons.length && <ul className="space-y-1 text-xs text-amber-800">
        {reference.unresolvedReasons.map((reason) => <li key={reason}>{REASON[reason]}</li>)}
      </ul>}
    </article>)}
    {!!documents.length && <div className="space-y-2">
      <h4 className="font-medium">المستندات الفعلية · كل مستند مرة واحدة</h4>
      {documents.map((document) => <div key={document.invoiceId} className="space-y-1 rounded-lg border bg-white p-2">
        <p className="break-words"><a className="text-sky-700 underline" href={`/print/invoice/${document.invoiceId}`} target="_blank" rel="noopener noreferrer">{document.invoiceNumber}</a>
          {" · "}{document.status === "cancelled" ? "ملغاة ومحفوظة" : document.status === "paid" ? "مسددة بحسب حالة المستند" : "مفتوحة"}</p>
        <p>صافي المستند: {formatMoney(document.netMinor, document.currency)} · السندات المرتبطة به مباشرة: {formatMoney(document.directlyLinkedSettledMinor, document.currency)}</p>
        <p className="text-xs text-slate-600">قد تبقى سندات التصحيح على المستند الأصلي. لا يُحسب مبلغ تحصيل جديد من الفرق بين هذين الرقمين.</p>
      </div>)}
    </div>}
    <div className="space-y-1 border-t pt-2">
      <h4 className="font-medium">الرصيد الحالي لحساب المريض بالكامل، حسب العملة</h4>
      {!currencies.length && <p>لا يوجد رصيد مالي قائم في الحساب.</p>}
      {currencies.map((currency) => <p key={currency}>{currency}: {formatMoney(data.accountPositions[currency].dueMinor, currency)}</p>)}
      {data.openingPositions.map((position) => <p key={position.currency} className="text-xs text-slate-600">
        الرصيد السابق {position.currency}: عند التسجيل {formatMoney(position.openingMinor, position.currency)} · المسوّى {formatMoney(position.settledMinor, position.currency)} · المتبقي {formatMoney(position.remainingMinor, position.currency)}
      </p>)}
      <p className="text-xs text-slate-500">الأرقام أعلاه من الحساب القائم. مراجع التغطية لا تقرر تلقائيًا شمول الشدات أو المثبتات أو الأعمال الإضافية، ولا تعيد توزيع العمولة.</p>
    </div>
  </section>;
}
