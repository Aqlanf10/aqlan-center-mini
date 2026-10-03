"use client";

import { useEffect, useState } from "react";

interface PlanOption { id: number; title: string; status: string; hasInstallments: boolean }

/**
 * (P1-B) باقة التقويم: حالة التقويم سجلٌ سريري مفتوح العدد من الشدّات، والاتفاق (خطة بأقساط)
 * هو ما يُفوتَر. ربطهما يجعل كل شدّةٍ قادمة «مشمولة» — يقرره الخادم ويُدقَّق، ولا يُنشئ فاتورة.
 */
export function OrthoPackageLink({ caseId, patientId, planId, canLink, onChanged }: {
  caseId: number; patientId: number; planId: number | null; canLink: boolean; onChanged: () => void;
}) {
  const [plans, setPlans] = useState<PlanOption[] | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/plans?patientId=${patientId}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { plans: PlanOption[] };
        if (!cancelled) setPlans(payload.plans.filter((plan) => plan.status !== "cancelled"));
      } catch {
        // البطاقة مساعدة — الحالة تعمل بدونها.
      }
    })();
    return () => { cancelled = true; };
  }, [patientId]);

  const linked = plans?.find((plan) => plan.id === planId) ?? null;
  const agreements = (plans ?? []).filter((plan) => plan.hasInstallments === true);

  async function save(next: number | null) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/ortho/${caseId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: next }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) { setMessage(payload.message ?? "تعذّر حفظ الربط."); return; }
      setChoice("");
      onChanged();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }

  const funded = linked !== null && linked.hasInstallments === true;
  return (
    <section aria-label="اتفاق التقويم"
      className={`mt-2 rounded-xl border px-3 py-2 text-[11px] ${funded ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
      {planId !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-extrabold text-navy-900">
            {funded ? "✓ باقة تقويم: " : "مربوطة بخطة: "}{linked?.title ?? `خطة #${planId}`}
          </span>
          <span className="text-slate-700">
            {funded
              ? "الشدّات مشمولة بالأقساط — بلا عددٍ محدد ولا فاتورة لكل شدّة."
              : linked ? "الخطة بلا أقساط — الشدّات لا تُعدّ مشمولة حتى يُجدوَل الاتفاق." : "تعذّر التحقق من اتفاق الخطة المرتبطة."}
          </span>
          {canLink ? (
            <button type="button" disabled={busy} onClick={() => void save(null)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50">
              فكّ الربط
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-extrabold text-navy-900">لا اتفاق مالي مربوط بالحالة</span>
          <span className="text-slate-700">الشدّة تحتاج قرار فوترة حتى تُربط الحالة باتفاق أقساط.</span>
          {canLink && agreements.length > 0 ? (
            <>
              <select value={choice} onChange={(event) => setChoice(event.target.value)} aria-label="اختر اتفاق الأقساط"
                className="rounded-lg border border-slate-300 bg-white px-2 py-0.5">
                <option value="">اختر اتفاق الأقساط…</option>
                {agreements.map((plan) => <option key={plan.id} value={plan.id}>{plan.title}</option>)}
              </select>
              <button type="button" disabled={busy || !choice} onClick={() => void save(Number(choice))}
                className="rounded-lg border border-navy-300 bg-white px-2 py-0.5 font-bold text-navy-900 hover:bg-navy-100 disabled:opacity-50">
                اربط
              </button>
            </>
          ) : canLink && plans !== null ? (
            <a href={`/patients/${patientId}?tab=plans`} className="font-bold text-navy-800 underline underline-offset-4">
              أنشئ اتفاق تقويم من تبويب الخطط
            </a>
          ) : null}
        </div>
      )}
      {message ? <p role="alert" className="mt-1 font-bold text-red-700">{message}</p> : null}
    </section>
  );
}
