import type { compareSavedDiagnoses } from "@/lib/ortho-diagnosis-comparison";

type Comparison = Extract<ReturnType<typeof compareSavedDiagnoses>, { ok: true }>;
type Cell = Comparison["fields"][number]["left"];
const names: Record<string, string> = { skeletal: "الصنف الهيكلي", dental: "الصنف السني", crowding: "الازدحام", overjet: "Overjet", bite: "الإطباق", note: "الملاحظة" };
function Value({ cell }: { cell: Cell }) {
  if (cell.state === "absent") return <span>الحقل غير موجود في هذا القيد</span>;
  if (cell.state === "null") return <span>قيمة null محفوظة، دون نص</span>;
  if (cell.state === "empty") return <span>نص فارغ محفوظ</span>;
  return <><span className="block text-[10px] text-slate-500">نص مسجّل كما حُفظ، بما فيه المسافات</span><span className="whitespace-pre-wrap break-words">{cell.value}</span></>;
}
/** Already-authorized saved entries only. No merging, interpretation, or writes. */
export function OrthoDiagnosisComparison({ comparison }: { comparison: Comparison }) {
  return <div data-testid="ortho-diagnosis-comparison" className="space-y-3 text-xs">
    <p>أرقام النسخ تتبع سجل المريض الكامل؛ الفجوات لا تثبت فقدان قيود هذه الحالة. المقارنة حرفية للنص وحالة الحقل فقط، وليست تقييمًا سريريًا.</p>
    <div className="grid gap-3 sm:grid-cols-2">{([comparison.left, comparison.right] as const).map((entry, index) => <section key={entry.id} className="min-w-0 space-y-1 break-words rounded-lg bg-slate-50 p-2" aria-label={`بيانات القيد ${index === 0 ? "الأول" : "الثاني"}`}>
      <h6 className="font-bold">القيد {index === 0 ? "الأول" : "الثاني"} · #{entry.id} · نسخة {entry.version}</h6>
      <p>المسجّل: <span className="whitespace-pre-wrap">{entry.createdBy}</span></p>
      <p>وقت التسجيل: <time dateTime={entry.createdAt} dir="ltr">{entry.createdAt}</time></p>
      <p>عنوان القيد: <span className="whitespace-pre-wrap">{entry.label === null ? "غير مسجّل (null)" : entry.label === "" ? "نص فارغ محفوظ" : entry.label}</span></p>
    </section>)}</div>
    {comparison.fields.length === 0 ? <p>لا توجد مفاتيح حقول محفوظة في أي من القيدين.</p> : <div className="overflow-x-auto" role="region" aria-label="حقول القيدين المحفوظة" tabIndex={0}>
      <table className="w-full min-w-[36rem] table-fixed border-collapse text-start">
        <caption className="pb-2 text-start">القيم الأصلية للقيدين، بلا استكمال من قيود أخرى</caption>
        <thead><tr>{["الحقل", "القيد الأول", "القيد الثاني", "المطابقة الحرفية"].map(label => <th key={label} scope="col" className="border p-2 text-start">{label}</th>)}</tr></thead>
        <tbody>{comparison.fields.map(field => <tr key={field.key}>
          <th scope="row" className="break-words border p-2 text-start align-top">{Object.hasOwn(names, field.key) ? names[field.key] : "حقل محفوظ آخر"}<bdi dir="ltr" className="block whitespace-pre-wrap font-normal">{field.key}</bdi></th>
          <td className="border p-2 align-top"><Value cell={field.left} /></td><td className="border p-2 align-top"><Value cell={field.right} /></td>
          <td className="border p-2 align-top">{field.comparison === "same" ? "متطابق نصيًا وحالةً" : "مختلف نصيًا أو في حالة التسجيل"}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </div>;
}
