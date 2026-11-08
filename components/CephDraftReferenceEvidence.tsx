import { CEPH_REFERENCE_NOTICE, type CephDraftReferenceContext } from "@/lib/cephPresentation";

/** Informational catalog evidence only. No arithmetic or patient grading. */
export function CephDraftReferenceEvidence({ context }: { context: CephDraftReferenceContext }) {
  const set = context.referenceSet;
  return <div role="note" data-testid="ceph-draft-reference-evidence" className="break-words border-b border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
    <p>{CEPH_REFERENCE_NOTICE}</p>
    {set ? <>
      <p>مصدر أرقام هذه المراجعة: {context.name} · <span dir="ltr">{context.source}</span></p>
      <p>بيانات الكتالوج: السكان {set.population ?? "غير موثّق"} · الأعمار {set.ageMin ?? "؟"}–{set.ageMax ?? "؟"} · الجنس {set.sex ?? "غير موثّق"} · نشط وقت القراءة.</p>
      <p className="break-all" dir="ltr">Reference SHA-256: {context.identity?.referenceSetSha256}</p>
      <p>البصمة واردة من الخادم؛ لا يُعاد حسابها في المتصفح. الرموز الغائبة لا تستعير أرقامًا من المراجع المدمجة.</p>
    </> : <p>{context.name}</p>}
  </div>;
}
