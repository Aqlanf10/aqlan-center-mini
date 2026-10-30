"use client";

import { PrescriptionMedicationPreview } from "./PrescriptionMedicationPreview";
import { useState } from "react";
import { MEDICATION_REFERENCES } from "@/lib/prescription-medication-library";

// Keep Latin dose expressions and ranges together in the RTL clinical text.
function referenceText(value: string) {
  return value.split(/([A-Za-z0-9]+(?:[ \t]*[A-Za-z0-9.%/–−-]+)*)/g).map((part, index) =>
    /^[A-Za-z0-9]/.test(part) ? <bdi dir="ltr" key={index}>{part}</bdi> : part);
}

/** Review-only: intentionally has no callback that could add, save or approve Rx items. */
export function PrescriptionMedicationLibrary() {
  const [query, setQuery] = useState("");
  const [population, setPopulation] = useState<"adult" | "child">("adult");
  const entries = MEDICATION_REFERENCES.filter(entry => `${entry.genericName} ${entry.arabicName}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <details className="rounded-xl border border-slate-200 p-3 text-xs" data-medication-library="review-only">
      <summary className="cursor-pointer font-bold">مكتبة أدوية إرشادية — تُراجع الجرعة والتعليمات ويعتمدها الطبيب لكل مريض</summary>
      <p className="my-2 text-slate-600">أربعة مدخلات أولية للمراجعة؛ ليست مكتبة كاملة أو اعتمادًا محليًا. الإضافة للوصفة والحساب السريري غير مفعّلين حتى مراجعة المالك.</p>
      <div className="flex flex-wrap gap-2">
        <label>بحث باسم الدواء<input aria-label="بحث في مكتبة الأدوية" value={query} onChange={e => setQuery(e.target.value)} className="mx-2 rounded border p-2" /></label>
        <label>الفئة<select aria-label="الفئة العمرية للمراجع" value={population} onChange={e => setPopulation(e.target.value as "adult" | "child")} className="mx-2 rounded border p-2"><option value="adult">بالغ</option><option value="child">طفل</option></select></label>
      </div>
      {entries.length === 0 && <p className="mt-3">لا توجد نتيجة في المدخلات الأولية.</p>}
      {entries.map(entry => <article key={entry.id} className="mt-3 rounded-lg border border-slate-200 p-3">
        <h4 className="font-bold"><span dir="ltr">{entry.genericName}</span> — {entry.arabicName}</h4>
        <p className="mt-1 text-slate-500">بانتظار مراجعة المالك · {entry.version}</p>
        <p className="mt-2 leading-6">{referenceText(entry[population])}</p>
        <p className="mt-2 leading-6">{referenceText(entry.instructions)}</p>
        <p dir="ltr" className="mt-2 text-slate-500">{entry.units}</p>
        <ul className="mt-2 space-y-1">{entry.sources.map(source => <li key={source.url}><a className="underline" href={source.url} target="_blank" rel="noreferrer">{source.title}</a> · {source.version}</li>)}</ul>
        <button type="button" disabled className="mt-2 rounded border px-3 py-2 text-slate-500">إضافة للوصفة — غير مفعّل للمراجعة</button>
      </article>)}
      <PrescriptionMedicationPreview />
    </details>
  );
}
