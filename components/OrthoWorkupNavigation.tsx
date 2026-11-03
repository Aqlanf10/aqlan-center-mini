"use client";
import { ORTHO_WORKUP_STEPS } from "@/lib/ortho-workup-navigation";
export function OrthoWorkupNavigation({ step, legacy, onSelect, onClose }: { step: number; legacy: boolean; onSelect(step: number): void; onClose(): void }) {
  const selected = ORTHO_WORKUP_STEPS[step];
  if (!selected) return null;
  return <section aria-label="إعداد ملف التقويم خطوة بخطوة" className="m-3 space-y-3 rounded-xl border border-navy-200 bg-navy-50 p-3 sm:m-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">{legacy ? "استكمال ملف التقويم" : "إعداد ملف التقويم خطوة بخطوة"}</h3><button type="button" className="min-h-11 rounded-lg border bg-white px-3 text-sm" onClick={onClose}>العودة لأقسام الحالة</button></div>
    <label className="block text-sm font-bold">الانتقال إلى خطوة<select aria-label="خطوة إعداد ملف التقويم" className="mt-1 min-h-11 w-full rounded-lg border bg-white p-2" value={step} onChange={event => onSelect(Number(event.target.value))}>{ORTHO_WORKUP_STEPS.map((item, index) => <option key={item.id} value={index}>{index + 1}. {item.title}</option>)}</select></label>
    <p className="text-sm">{selected.hint}</p>
    <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" disabled={step === 0} className="min-h-11 rounded-lg border bg-white px-3 text-sm disabled:opacity-40" onClick={() => onSelect(step - 1)}>الخطوة السابقة</button><span role="status" className="text-sm">الخطوة {step + 1} من {ORTHO_WORKUP_STEPS.length}</span><button type="button" disabled={step === ORTHO_WORKUP_STEPS.length - 1} className="min-h-11 rounded-lg border bg-white px-3 text-sm disabled:opacity-40" onClick={() => onSelect(step + 1)}>الخطوة التالية دون حفظ</button></div>
    <p className="text-xs text-slate-600">احفظ التعديلات من القسم المفتوح. الانتقال بين الخطوات لا يحفظها ولا يعتمد الحالة سريرياً.</p>
  </section>;
}
