"use client";
import { useState } from "react";
import { MEDICATION_PREVIEW_PROFILES } from "@/lib/prescription-medication-preview";
import { calculateMedicationTemplate, type MedicationTemplateContext } from "@/lib/prescription-medication-templates";

export function PrescriptionMedicationPreview() {
  const [profileId, setProfileId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState(false);
  const profile = MEDICATION_PREVIEW_PROFILES.find(p => p.id === profileId);
  const num = (key: string) => values[key]?.trim() ? Number(values[key]) : NaN;
  const set = (key: string, value: string) => setValues(prev => ({ ...prev, [key]: value }));
  const context: MedicationTemplateContext | null = profile ? {
    purpose: "synthetic-preview", ageMonths: num("age"), weightKg: num("weight"), currentWeightConfirmed: reviewed,
    concentration: { mg: num("strength"), ml: num("volume") }, measuringIncrementMl: num("increment"),
    solid: { mgPerUnit: num("strength"), incrementUnits: num("increment") }, productReviewed: reviewed,
    selectedAmount: num("amount"), intervalHours: num("interval"), maxDoses24h: num("maxDoses"),
    durationDays: num("duration"), durationReviewed: reviewed, clinicalReviewConfirmed: reviewed,
    indication: values.indication ?? "", indicationRationale: values.rationale ?? "",
    allergyReviewed: reviewed, renalReviewed: reviewed, localTreatmentPlanReviewed: reviewed,
    priorDoses24h: { count: num("priorCount"), totalMg: num("priorMg"), hoursSinceLastDose: values.since ? num("since") : null }, plannedDoses24h: num("planned"),
  } : null;
  const result = profile && context ? calculateMedicationTemplate(profile, context) : null;
  const fields = profile ? [
    ["age", "العمر بالأشهر"], ["weight", "الوزن المقاس kg"], ["amount", `المقدار المختار ${profile.dosing.basis}`],
    ["interval", "الفاصل بالساعات"], ["maxDoses", "أقصى عدد جرعات في أي 24 ساعة"], ["duration", "المدة التي اختارها الطبيب بالأيام"],
    ["strength", profile.formKind === "liquid" ? "كمية المادة mg المكتوبة على العبوة" : "قوة القرص mg/unit"],
    ...(profile.formKind === "liquid" ? [["volume", "حجم التركيز المكتوب mL"]] : []),
    ["increment", profile.formKind === "liquid" ? "خطوة أداة القياس mL" : "خطوة تقسيم القرص المؤكدة من المنتج"],
    ["priorCount", "عدد الجرعات السابقة خلال 24 ساعة (اكتب 0 إن لم توجد)"], ["priorMg", "مجموع mg السابقة خلال 24 ساعة"],
    ["since", "الساعات منذ آخر جرعة إن وجدت"], ["planned", "الجرعات المخطط لها ضمن نافذة 24 ساعة"],
  ] : [];
  return <details className="mt-3 rounded-xl border border-slate-300 p-3 text-xs" data-medication-preview="synthetic-only">
    <summary className="cursor-pointer font-bold">معاينة حسابية اصطناعية للقوالب — لا تُضاف إلى وصفة المريض</summary>
    <p className="my-2 leading-6">هذه معاينة هندسية لمراجعة القوالب، وليست تحققًا آليًا من صحة الاستطباب أو اعتمادًا للعلاج. لا تدخل بيانات مريض فعلي. ملفات الباراسيتامول والإيبوبروفين والغسول مرجعية نصية إلى استكمال نطاق المنتج المحلي.</p>
    <label>ملف المعاينة<select aria-label="ملف المعاينة الحسابية" value={profileId} onChange={event => { setProfileId(event.target.value); setValues({}); setReviewed(false); }} className="m-2 rounded border p-2">
      <option value="">اختر ملفًا صراحة</option>{MEDICATION_PREVIEW_PROFILES.map(p => <option key={p.id} value={p.id}>{p.genericName} · كل {p.dosing.minimumIntervalHours} ساعات · {p.formKind === "liquid" ? "سائل" : "قرص"}</option>)}
    </select></label>
    {profile && <>
      <p className="my-2 leading-6">نطاق أول معاينة: أكبر من 3 أشهر وأقل من 12 سنة، ووزن أقل من 40 kg. خارج هذا النطاق مراجعة يدوية، وليس حكمًا بمنع الدواء. المقدار اليومي <bdi dir="ltr">{profile.dosing.amountRange.min}–{profile.dosing.amountRange.max} mg/kg/day</bdi>، سقف الجرعة <bdi dir="ltr">{profile.dosing.maxMgPerDose} mg</bdi>. السقف اليومي الوزني <bdi dir="ltr">{profile.dosing.maxMgPerKgPerDay} mg/kg/day</bdi>، والسقف المطلق المحسوب من سقف الجرعة × عددها <bdi dir="ltr">{profile.dosing.maxMgPerDay} mg/day</bdi>.</p>
      <p className="my-2">ينقص اعتماد المنتج المحلي: الاسم العلمي، الشكل، التركيز بعد التحضير، العمر المسموح، أداة القياس أو قابلية تقسيم القرص، ونشرة الكلى والحساسية. مدة الطفل يختارها الطبيب حسب الاستطباب ولا تُفترض من البالغ.</p>
      <a href={profile.source.url} target="_blank" rel="noreferrer" className="underline">{profile.source.title} · {profile.source.version} · {profile.source.section}</a>
      <div className="my-3 grid gap-3 sm:grid-cols-2">{fields.map(([key, label]) => <label key={key} className="grid gap-1">{label}<input aria-label={label} inputMode="decimal" value={values[key] ?? ""} onChange={event => set(key, event.target.value)} className="rounded border p-2" dir="ltr" /></label>)}</div>
      <label className="block">الاستطباب المختار<select aria-label="استطباب المعاينة" value={values.indication ?? ""} onChange={event => set("indication", event.target.value)} className="m-2 rounded border p-2"><option value="">اختر الاستطباب بعد تقييم الطبيب</option>{profile.indicationOptions.map(i => <option key={i}>{i}</option>)}</select></label>
      <label className="block">تفسير التقييم وخطة العلاج الموضعي<textarea aria-label="تفسير المعاينة" value={values.rationale ?? ""} onChange={event => set("rationale", event.target.value)} className="mt-1 w-full rounded border p-2" /></label>
      <label className="my-3 flex gap-2"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />أراجع اصطناعيًا العمر والوزن والمنتج والحساسية والكلى والمدة وخطة العلاج؛ هذا الإقرار لا يعتمد استطبابًا ولا يفعّل وصفة.</label>
      {result && (result.ok ? <div role="status" className="rounded border p-3 leading-6">
        <p>المطلوب قبل التقريب: <bdi dir="ltr">{Number(result.requestedMgPerDose.toPrecision(10))} mg/dose</bdi></p>
        <p>بعد خطوة القياس: <bdi dir="ltr">{Number(result.mgPerDose.toPrecision(10))} mg/dose</bdi> · <bdi dir="ltr">{result.mlPerDose === null ? `${result.unitsPerDose} unit(s)` : `${result.mlPerDose} mL`}</bdi></p>
        <p>{result.roundingMessage}</p><p>مجموع النافذة: <bdi dir="ltr">{result.rolling24hMg} mg/24h</bdi>. تحقق الحدود حسابي فقط؛ القرار السريري للطبيب.</p>
        <p dir="ltr">{result.item.frequency}</p><p>{result.item.instructions}</p><p dir="ltr">{result.item.duration}</p>
      </div> : <p role="status" className="rounded bg-amber-50 p-3">{result.message}</p>)}
      <button type="button" disabled className="mt-3 rounded border p-2 text-slate-500">تعبئة وصفة المريض — غير مفعّل قبل مراجعة المحتوى والمنتج</button>
    </>}
  </details>;
}
