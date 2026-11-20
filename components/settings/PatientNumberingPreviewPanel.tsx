"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { normalizeNumberingFormDigits, numberingDraft, numberingPreviewProblem, validNumberingSnapshot,
  type NumberingDisplaySnapshot, type NumberingPreviewProvider } from "./patient-numbering-preview-model";

export interface PatientNumberingPreviewPanelProps {
  /** Caller-supplied display values only; not proof of current settings or owner authority. */
  current: NumberingDisplaySnapshot;
  /** Client-parent injection for synthetic preview only. No production adapter is installed. */
  onPreview?: NumberingPreviewProvider;
}
type Context = { key: string; provider: NumberingPreviewProvider | undefined };
type Check = { kind: "idle" } | {
  kind: "pending" | "checked" | "refused" | "stale"; context: Context; message?: string;
};

/** Unmounted source-only UI. Never reads settings, calls a route or offers a save action. */
export function PatientNumberingPreviewPanel({ current, onPreview }: PatientNumberingPreviewPanelProps) {
  const id = useId();
  const [prefix, setPrefix] = useState(() => current.prefix.trim().toUpperCase());
  const [next, setNext] = useState(current.next);
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  const attempt = useRef(0), mounted = useRef(true), inFlight = useRef<number | null>(null);
  const key = JSON.stringify([current.prefix, current.next, current.revision, prefix, next]);
  const [context, setContext] = useState<Context>({ key, provider: onPreview });
  const contextChanged = context.key !== key || context.provider !== onPreview;
  // Distinct state identity prevents a checked result from reviving after A/B/A.
  // Adjust only this component's state during render; no ref mutation in render.
  if (contextChanged) setContext({ key, provider: onPreview });
  useLayoutEffect(() => {
    attempt.current += 1; inFlight.current = null;
  }, [context]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; attempt.current += 1; inFlight.current = null; };
  }, []);

  const draft = numberingDraft(prefix, next);
  const snapshotValid = validNumberingSnapshot(current);
  const currentPreview = snapshotValid ? numberingDraft(current.prefix, current.next)!.preview : "غير متاح";
  const matching = !contextChanged && check.kind !== "idle" && check.context === context;
  const status = check.kind === "idle" ? "idle" : matching ? check.kind : "stale";
  const busy = status === "pending";
  const inputProblem = draft ? null : numberingPreviewProblem("invalid-input");
  const notice = status === "stale" ? numberingPreviewProblem("stale-preview")
    : status === "pending" ? "جارٍ فحص المعاينة فقط…"
    : status === "checked" ? "اجتازت المعاينة الفحص التجريبي للقيم المعروضة. لم يُحفظ شيء."
    : status === "refused" && check.kind !== "idle" ? check.message : "";

  function edit(field: "prefix" | "next", value: string) {
    attempt.current += 1; inFlight.current = null;
    if (field === "prefix") setPrefix(value); else setNext(normalizeNumberingFormDigits(value));
    setCheck({ kind: "stale", context });
  }
  async function inspect() {
    if (!draft || !snapshotValid || !onPreview || busy || inFlight.current !== null) return;
    const provider = onPreview, token = ++attempt.current;
    inFlight.current = token;
    setCheck({ kind: "pending", context });
    const stillCurrent = () => mounted.current && token === attempt.current;
    try {
      const result = await provider({ prefix: draft.prefix, next: draft.next, expectedRevision: current.revision });
      if (!stillCurrent()) return;
      if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
        setCheck({ kind: "refused", context, message: numberingPreviewProblem("invalid-response") }); return;
      }
      if (!result.ok) {
        setCheck({ kind: "refused", context, message: numberingPreviewProblem(result.reason) }); return;
      }
      if (result.prefix !== draft.prefix || result.next !== draft.next || result.preview !== draft.preview
        || result.expectedRevision !== current.revision) {
        setCheck({ kind: "stale", context }); return;
      }
      setCheck({ kind: "checked", context });
    } catch {
      if (stillCurrent()) setCheck({ kind: "refused", context, message: numberingPreviewProblem("unavailable") });
    } finally {
      if (inFlight.current === token) inFlight.current = null;
    }
  }

  const fieldClass = "min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-left font-mono text-sm focus:outline-none focus:ring-2 focus:ring-sky-500";
  return <section dir="rtl" aria-labelledby={`${id}-title`} className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-800">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={`${id}-title`} className="text-sm font-extrabold text-navy-900">ترقيم ملفات المرضى</h2>
      <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-900">معاينة غير مفعّلة</span>
    </div>
    <p id={`${id}-scope`} className="mt-2 text-sm leading-6 text-slate-600">
      إعداد خاص بمالك العيادة. تختار حرف السلسلة ورقم البداية للملفات الجديدة، ولا تتغيّر أرقام الملفات الموجودة.
      هذه واجهة تجريبية غير متصلة بالإعدادات، ولا تنفّذ أي حفظ.
    </p>
    <form aria-describedby={`${id}-scope`} onSubmit={event => { event.preventDefault(); void inspect(); }} className="mt-4 space-y-4">
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">اختيار السلسلة ورقم البداية</legend>
        <label className="block text-sm font-bold" htmlFor={`${id}-prefix`}>حرف السلسلة
          <select id={`${id}-prefix`} dir="ltr" value={prefix} onChange={event => edit("prefix", event.target.value)} className={`${fieldClass} mt-1`}>
            <option value="">اختر حرفًا</option>
            {[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(letter => <option key={letter} value={letter}>{letter}</option>)}
          </select>
        </label>
        <label className="block text-sm font-bold" htmlFor={`${id}-next`}>رقم البداية / الرقم التالي
          <input id={`${id}-next`} type="text" inputMode="numeric" dir="ltr" value={next} autoComplete="off" spellCheck={false}
            aria-invalid={inputProblem ? true : undefined} aria-describedby={`${id}-number-help ${id}-problem`}
            onChange={event => edit("next", event.target.value)} className={`${fieldClass} mt-1`} />
        </label>
      </fieldset>
      <p id={`${id}-number-help`} className="text-xs leading-5 text-slate-600">
        اكتب الأرقام 0–9 دون فواصل أو صفر في البداية؛ مثل 1500 ليظهر A-01500 عند اختيار A.
        تُحوّل الأرقام العربية والفارسية إلى 0–9 في الحقل والمعاينة قبل الفحص، دون تغيير قيمة الرقم.
      </p>
      <p id={`${id}-problem`} role={inputProblem ? "alert" : undefined} className="text-sm text-rose-700">{inputProblem}</p>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <dt className="text-xs font-bold text-slate-600">القيمة الحالية المعروضة</dt>
          <dd className="mt-1 break-all font-mono text-lg font-bold"><bdi dir="ltr">{currentPreview}</bdi></dd>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
          <dt className="text-xs font-bold text-sky-900">القيمة المقترحة للملف الجديد</dt>
          <dd className="mt-1 break-all font-mono text-lg font-bold text-navy-900"><bdi dir="ltr">{draft?.preview ?? "—"}</bdi></dd>
        </div>
      </dl>
      {!snapshotValid && <p role="alert" className="text-sm text-rose-700">القيم الحالية غير مكتملة. يلزم إعادة قراءتها قبل الفحص.</p>}
      {!onPreview && <p className="text-sm text-slate-600">مصدر فحص المعاينة غير موصول. لا يمكن اعتماد هذه القيم.</p>}
      <button type="submit" disabled={!draft || !snapshotValid || !onPreview || busy}
        className="min-h-11 rounded-xl bg-navy-800 px-4 py-2 text-sm font-extrabold text-white focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? "جارٍ الفحص…" : "فحص المعاينة فقط"}
      </button>
      <p role="status" aria-live="polite" aria-atomic="true" className="min-h-6 text-sm leading-6 text-slate-700">{notice}</p>
      <p className="text-xs leading-5 text-slate-500">لا يوجد زر حفظ هنا. اعتماد التغيير لاحقًا يتطلب التحقق من صلاحية المالك وسجل الأرقام السابقة ومنع تكرار الأرقام على الخادم.</p>
    </form>
  </section>;
}
