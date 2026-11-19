/**
 * OP-4 — تذكير ثبات التصوير (قراءة فقط).
 * العقد: docs/review/ortho-wire-timeline-photo-records-contract-20261118.md (v2.1).
 * النص من إعداد المركز `ortho.photo_checklist`؛ فارغ = لا شيء يُرسم. بطاقة مطوية بلا
 * حقول ولا إجابات تُخزَّن، ولا تمنع الحفظ ولا تضيف خطوة إلى الشدّة.
 */
export function PhotoChecklistCard({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <details className="mb-1.5 rounded-lg border border-sky-100 bg-sky-50/60 px-2 py-1 text-[10px] text-slate-700" data-testid="ortho-photo-checklist">
      <summary className="cursor-pointer font-bold text-sky-800">تذكير ثبات التصوير ({items.length})</summary>
      <ul className="mt-1 list-disc space-y-0.5 pr-4">
        {items.map(item => <li key={item}>{item}</li>)}
      </ul>
    </details>
  );
}
