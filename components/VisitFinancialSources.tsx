"use client";
import { useEffect, useState } from "react";
import { canViewMoney } from "@/lib/roles";
import { VISIT_SOURCE_SUMMARY, type VisitFinancialContext } from "@/lib/visit-financial-context";

const kinds = { procedure: "إجراء", plan_item: "بند علاج", orthodontic_adjustment: "جلسة تقويم", endodontic_record: "سجل علاج جذور" };
const sources = { invoice: "فاتورة", historical_agreement: "اتفاق سابق", approved_agreement: "اتفاق معتمد", installment_plan: "جدول خطة" };
const reasons: Record<string, string> = {
  plan_item_owner_unverified: "تعذّر تثبيت ملكية بند العلاج",
  plan_source_needs_review: "بند العلاج أو مصدره يحتاج مراجعة",
  invoice_owner_unverified: "تعذّر تثبيت ملكية مرجع الفاتورة",
  historical_source_needs_review: "هوية الاتفاق السابق أو تغطيته تحتاج مراجعة",
  approved_source_unverified: "مرجع اتفاق معتمد؛ لم تُثبت تغطية هذا العمل هنا",
  multiple_financial_sources: "توجد مصادر متعارضة تحتاج مراجعة",
  installment_principal_unverified: "جدول الأقساط وحده لا يثبت أصل التغطية",
  invoice_item_identity_conflict: "هوية بند الفاتورة لا تطابق العمل المسجل",
  procedure_plan_identity_conflict: "الإجراء لا يطابق بند العلاج المرتبط",
  adjustment_owner_unverified: "تعذّر تثبيت ملكية جلسة التقويم",
  adjustment_coverage_unverified: "قرار فوترة مسجل؛ تغطية الجلسة غير محسومة",
  adjustment_source_unresolved: "لا مصدر أو قرار رسوم مكتمل لهذه الجلسة",
  endo_work_item_not_explicit: "سجل الجذور لا يحدد بند العمل المالي صراحةً",
  endo_owner_unverified: "تعذّر تثبيت ملكية سجل الجذور",
  unsigned_work: "العمل لم يُوقّع بعد",
  source_not_established: "لا مصدر تغطية مثبت لهذا العمل",
};
export function VisitFinancialSourceDetails({ context, financial }: { context: VisitFinancialContext; financial: boolean }) {
  return <section className="mb-4 rounded-xl border border-slate-200 bg-white p-3" aria-label="مصادر عمل الزيارة">
    <p className="text-sm font-bold">{VISIT_SOURCE_SUMMARY[context.summary]}</p>
    <p className="mt-1 text-xs text-slate-500">تحقق حالي من العمل المسجل؛ التغطية لا تعني السداد. غياب المصدر لا يعني دينًا أو مجانية.</p>
    {context.work.length > 0 ? <ul className="mt-2 space-y-2 text-xs">{context.work.map(line => <li key={line.key}>
      <span>{kinds[line.kind]} #{line.id}: {line.reasons.length ? "يحتاج مراجعة" : line.coverage === "verified" ? "مصدر تغطية مثبت" : line.decision === "no_charge" ? "قرار بلا رسوم مسجل" : "مصدر غير محسوم"}</span>
      {line.reasons.length > 0 ? <p className="mt-1 text-slate-500">{line.reasons.map(reason => reasons[reason] ?? "مصدر غير محسوم").join("؛ ")}</p> : null}
      {financial && line.references.length > 0 ? <ul className="mr-4 mt-1">{line.references.map(source => <li key={`${source.kind}:${source.id}:${source.path}`}>
        {source.kind === "invoice" && source.state === "current" ? <a className="underline" href={`/print/invoice/${source.id}`} target="_blank" rel="noopener">{sources[source.kind]} #{source.id}</a> : <span>{sources[source.kind]} #{source.id}</span>}
        {source.state === "historical" ? " — مرجع تاريخي، ليس تغطية سارية" : source.state === "review" ? " — يحتاج مراجعة" : ""}
      </li>)}</ul> : null}
    </li>)}</ul> : null}
  </section>;
}
/** Mounted with a visit/session owner key. Never retain a previous owner's financial evidence. */
export default function VisitFinancialSources({ visitId, patientId, role }: { visitId: number; patientId: number | null; role?: string | null }) {
  const [result, setResult] = useState<VisitFinancialContext | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetch(`/api/visits/${visitId}/financial-context`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("Unavailable"); return response.json() as Promise<VisitFinancialContext>; })
      .then(context => { if (context.visitId !== visitId || context.patientId !== patientId) throw new Error("Owner changed"); if (active) setResult(context); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; controller.abort(); };
  }, [visitId, patientId]);
  if (!result) return <p className="mb-4 text-xs text-slate-500">{failed ? "تعذّر التحقق من مصادر العمل؛ أعد تحميل الزيارة." : "جارٍ التحقق من مصادر العمل…"}</p>;
  return <VisitFinancialSourceDetails context={result} financial={canViewMoney(role)} />;
}
