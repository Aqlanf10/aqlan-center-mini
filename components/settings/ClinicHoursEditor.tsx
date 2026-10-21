"use client";

import { useRef, useState } from "react";
import { CLINIC_HOURS_KEYS, validateSettingSet } from "@/lib/settings-validate";

type Hours = Record<(typeof CLINIC_HOURS_KEYS)[number], string>;
const labels = ["بداية الفترة الأولى", "نهاية الفترة الأولى", "بداية الفترة الثانية", "نهاية الفترة الثانية"];
function pickHours(values: Record<string, string>): Hours {
  return Object.fromEntries(CLINIC_HOURS_KEYS.map((key) => [key, values[key] ?? ""])) as Hours;
}

export function ClinicHoursEditor({ values, versions, editable, onSaved }: {
  values: Record<string, string>;
  versions: Record<string, string | null>;
  editable: boolean;
  onSaved: (payload: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Hours | null>(null);
  const [expected, setExpected] = useState<Record<string, string | null>>({});
  const [split, setSplit] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const shown = draft ?? pickHours(values);
  const problem = validateSettingSet(shown, {});

  function open() {
    const next = pickHours(values);
    setDraft(next);
    setSplit(Boolean(next["clinic.shift2_start"] || next["clinic.shift2_end"]));
    setExpected(Object.fromEntries(CLINIC_HOURS_KEYS.map((key) => [key, versions[key] ?? null])));
    setError(null); setSuccess(false);
  }
  async function save() {
    if (!draft || !editable || inFlight.current || problem || (split && !draft["clinic.shift2_start"])) return;
    inFlight.current = true; setSaving(true); setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, __versions: expected }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(typeof payload?.message === "string" ? payload.message : "تعذّر حفظ فترات الدوام. بقي تعديلك دون تغيير.");
        return;
      }
      // A malformed success is not a usable saved snapshot. Keep the draft and
      // original versions, so retrying cannot overwrite a potentially saved edit.
      if (!payload || typeof payload !== "object" || !payload.__versions ||
        CLINIC_HOURS_KEYS.some((key) => typeof payload[key] !== "string" ||
          !(key in payload.__versions) || !(payload.__versions[key] === null || typeof payload.__versions[key] === "string")) ||
        validateSettingSet(pickHours(payload), {})) {
        setError("استجابة الحفظ غير مكتملة. بقي تعديلك؛ حدّث الصفحة للتحقق قبل إعادة المحاولة.");
        return;
      }
      onSaved(payload); setDraft(null); setSuccess(true);
    } catch {
      setError("تعذّر تأكيد الحفظ. بقي تعديلك؛ تحقق من الاتصال وحدّث الصفحة قبل إعادة المحاولة.");
    } finally {
      inFlight.current = false; setSaving(false);
    }
  }

  return <article aria-label="فترات الدوام" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-2">
    <h2 className="text-sm font-black text-navy-950">فترات الدوام</h2>
    <p className="mt-1 text-xs leading-relaxed text-slate-500">دوام متواصل أو فترتان في اليوم نفسه. في وضع الفترتين، نهاية الفترة الأولى ليست نهاية اليوم؛ الوقت بين الفترتين فترة استراحة. الحجز اليدوي خارج الفترات يخضع لسياسة التحذير الحالية.</p>
    {draft ? <fieldset disabled={saving} className="mt-4">
      <legend className="text-sm font-bold">نظام الدوام</legend>
      <div className="my-3 flex flex-wrap gap-4">
        <label><input type="radio" name="clinic-hours-mode" checked={!split} onChange={() => {
          setSplit(false); setDraft({ ...draft, "clinic.shift2_start": "", "clinic.shift2_end": "" });
        }} /> دوام متواصل</label>
        <label><input type="radio" name="clinic-hours-mode" checked={split} onChange={() => setSplit(true)} /> فترتان</label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {CLINIC_HOURS_KEYS.map((key, index) => <label key={key} className="text-xs font-bold text-slate-700">
          {labels[index]}
          <input type="time" aria-label={labels[index]} value={draft[key]} disabled={index > 1 && !split}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
            className="mt-2 block min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100" />
        </label>)}
      </div>
      {!split ? <p className="mt-3 text-xs text-slate-600">حفظ الدوام المتواصل يمسح وقتَي الفترة الثانية معًا، ويحافظ على وقتَي الفترة الأولى كما أدخلتهما.</p> : null}
    </fieldset> : <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
      {CLINIC_HOURS_KEYS.map((key, index) => <div key={key}><dt className="text-slate-500">{labels[index]}</dt><dd className="font-bold" dir="ltr">{shown[key] || "غير مفعّلة"}</dd></div>)}
    </dl>}
    {problem ? <p role="alert" className="mt-3 text-sm text-amber-800">{draft ? problem : `أوقات الدوام المحفوظة تحتاج مراجعة: ${problem} لم تُغيّر تلقائيًا.`}</p> : null}
    {draft && split && !draft["clinic.shift2_start"] && !draft["clinic.shift2_end"] ? <p role="alert" className="mt-3 text-sm text-amber-800">أدخل وقتَي الفترة الثانية لاختيار فترتين.</p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-red-800">{error}</p> : null}
    {success ? <p role="status" className="mt-3 text-sm text-green-800">حُفظت فترات الدوام معًا وسُجّل التغيير.</p> : null}
    {editable ? <div className="mt-4 flex gap-2">
      {draft ? <>
        <button type="button" disabled={saving || Boolean(problem) || (split && !draft["clinic.shift2_start"])} onClick={() => void save()} className="min-h-11 rounded-xl bg-navy-950 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? "جارٍ الحفظ…" : "حفظ فترات الدوام"}</button>
        <button type="button" disabled={saving} onClick={() => { setDraft(null); setError(null); }} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm">إلغاء</button>
      </> : <button type="button" onClick={open} className="min-h-11 rounded-xl bg-navy-950 px-4 py-2 text-sm font-bold text-white">تعديل فترات الدوام</button>}
    </div> : <p className="mt-3 text-xs text-slate-500">للقراءة فقط</p>}
  </article>;
}
