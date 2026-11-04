"use client";

import { useEffect, useState } from "react";
import { CLINIC_BASE_CURRENCY, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { useSession } from "@/components/SessionProvider";

/**
 * شاشة الزيارة على المسار الموحّد (M2 slices 84–85).
 *
 * تعرض ما يعيده الخادم بعد إسقاط ما لا يملكه الحساب: الأسعار والمجاميع والعملات ومرجع
 * الفاتورة تظهر فقط إن أعادها الخادم (صلاحية عرض الفواتير أو المالك)، ولا تُستنتج ولا تُعرض
 * أصفارًا مكانها. بيانات التقويم تظهر فقط بصلاحية عرض التقويم.
 *
 * التوثيق لحامل clinical.visits.document: الملاحظات وحدها، والإجراءات (من العلاج المتبقّي،
 * والحذف) بلا أسعار — السطر غير المتغيّر يبقى بسعره المحفوظ، والجديد بسعر الخادم. والملحق
 * على الزيارة الموقَّعة. الخادم يقرّر كل شيء (الطبيب المرتبط أو المالك، أو زيارات اليوم
 * للملاحظات فقط)، والتوقيع لم يُفعَّل بعد على الحساب الموحّد.
 */
type Line = {
  id: number; serviceId: number; serviceName: string; toothCode: number | null; surfaces: string | null; quantity: number;
  doctorId: number | null; note: string | null; planItemId: number | null; unitPriceMinor?: number; totalMinor?: number; planCurrency?: Currency | null;
};
type Outstanding = {
  planItemId: number; serviceId: number | null; planTitle: string; serviceName: string; toothCode: number | null; surfaces?: string | null;
  sessionCount: number; doneSessions: number; status: string; unmetRequirements: string[];
};
type CockpitVisit = {
  id: number; patientId: number | null; patientName: string; status: "open" | "signed"; doctorId: number | null;
  signedAt: string | null; signedBy: string | null; arrivedAt: string;
  chiefComplaint: string | null; examination: string | null; diagnosis: string | null;
  treatmentDone: string | null; nextPlan: string | null; addendum: string | null;
  procedures: Line[]; outstanding: Outstanding[];
  previousVisit: { date: string; treatmentDone: string | null; proceduresSummary: string | null; nextPlan: string | null; diagnosis: string | null } | null;
  latestDiagnosis: { text: string; date: string } | null;
  activeCases: { id: number | null; kind: string; title: string; status: string; nextStep: string | null }[];
  labOrders: { id: number; workType: string; toothCode: number | null; status: string; labName: string }[];
  referral: { fromName: string | null; reason: string } | null;
  ortho?: { appliance: string; phase: string; upperWire: string | null; lowerWire: string | null; lastAdjustment: string | null } | null;
  totalMinor?: number; billingCurrency?: Currency | null; invoiceId?: number | null;
};
type NoteKey = "chiefComplaint" | "examination" | "diagnosis" | "treatmentDone" | "nextPlan";
type Draft = { key: string; serviceId: number; serviceName: string; toothCode: number | null; surfaces: string | null; quantity: number; doctorId: number | null; planItemId: number | null; note: string | null };

const NOTE_FIELDS: [NoteKey, string, number][] = [
  ["chiefComplaint", "الشكوى الرئيسية", 500], ["examination", "الفحص", 2000], ["diagnosis", "التشخيص", 2000],
  ["treatmentDone", "العلاج المنفّذ", 2000], ["nextPlan", "الخطة القادمة", 500],
];
const notesOf = (visit: CockpitVisit) => Object.fromEntries(NOTE_FIELDS.map(([key]) => [key, visit[key] ?? ""])) as Record<NoteKey, string>;
const draftsOf = (visit: CockpitVisit): Draft[] => visit.procedures.map(line => ({
  key: `saved-${line.id}`, serviceId: line.serviceId, serviceName: line.serviceName, toothCode: line.toothCode, surfaces: line.surfaces,
  quantity: line.quantity, doctorId: line.doctorId, planItemId: line.planItemId, note: line.note,
}));
const newKey = (prefix: string) => `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function CanonicalVisitClinical({ visitId }: { visitId: number }) {
  const session = useSession();
  const canDocument = session?.isOwner === true || (session?.capabilities ?? []).includes("clinical.visits.document");
  const [visit, setVisit] = useState<CockpitVisit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notes, setNotes] = useState<Record<NoteKey, string> | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [addendum, setAddendum] = useState("");
  const [addendumKey, setAddendumKey] = useState(() => newKey("visit-addendum"));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (payload: CockpitVisit) => { setVisit(payload); setNotes(notesOf(payload)); setDrafts(draftsOf(payload)); setError(null); };
  useEffect(() => {
    let live = true;
    const fail = (message: string) => { if (live) { setVisit(null); setError(message); } };
    fetch(`/api/visits/${visitId}/clinical`, { cache: "no-store" })
      .then(async response => {
        const payload = await response.json().catch(() => null) as (CockpitVisit & { message?: string }) | null;
        if (!response.ok || !payload || payload.id !== visitId) return fail(typeof payload?.message === "string" ? payload.message : "تعذّر تحميل الزيارة.");
        if (live) { setVisit(payload); setNotes(notesOf(payload)); setDrafts(draftsOf(payload)); setError(null); }
      })
      .catch(() => fail("تعذّر تحميل الزيارة."));
    return () => { live = false; };
  }, [visitId, attempt]);

  const submit = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setNotice(null);
    try {
      const response = await fetch(`/api/visits/${visitId}/clinical`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as (CockpitVisit & { message?: string }) | null;
      if (!response.ok || !payload || payload.id !== visitId) {
        setNotice({ ok: false, text: typeof payload?.message === "string" ? payload.message : "تعذّر حفظ الزيارة." });
        return false;
      }
      apply(payload); setNotice({ ok: true, text: done });
      return true;
    } catch {
      setNotice({ ok: false, text: "تعذّر الاتصال بالخادم؛ لم يُحفظ شيء مؤكد. أعد المحاولة." });
      return false;
    } finally { setBusy(false); }
  };

  if (error) {
    return (
      <div role="alert" data-testid="canonical-visit-error" className="rounded-2xl border border-danger-300 bg-danger-50 p-4 text-sm font-semibold text-danger-700">
        <p>{error}</p>
        <button type="button" onClick={() => { setError(null); setAttempt(n => n + 1); }} className="mt-2 min-h-10 rounded-xl border border-danger-300 px-3 text-xs font-bold">إعادة المحاولة</button>
      </div>
    );
  }
  if (!visit || !notes) return <p className="p-4 text-center text-sm text-slate-500" data-testid="canonical-visit-loading">جارٍ تحميل الزيارة…</p>;

  const base: Currency = isCurrency(visit.billingCurrency) ? visit.billingCurrency : CLINIC_BASE_CURRENCY;
  const showMoney = typeof visit.totalMinor === "number";
  const signed = visit.status === "signed";
  const editable = canDocument && !signed;
  const notesBody = { action: "save", ...notes, doctorId: visit.doctorId };
  const proceduresBody = {
    ...notesBody,
    procedures: drafts.map(line => ({ serviceId: line.serviceId, toothCode: line.toothCode, surfaces: line.surfaces, quantity: line.quantity, doctorId: line.doctorId, planItemId: line.planItemId, note: line.note })),
  };
  const draftsChanged = JSON.stringify(drafts.map(({ key: _key, ...rest }) => rest)) !== JSON.stringify(draftsOf(visit).map(({ key: _key, ...rest }) => rest));
  const remainingSessions = (item: Outstanding) => item.sessionCount - item.doneSessions - drafts.filter(line => line.planItemId === item.planItemId).length;

  return (
    <div className="space-y-3" data-testid="canonical-visit">
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-navy-900" data-testid="canonical-visit-patient">{visit.patientName}</h2>
          <span data-testid="canonical-visit-status" className={`rounded-full px-3 py-1 text-xs font-bold ${signed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
            {signed ? `موقَّعة${visit.signedBy ? ` — ${visit.signedBy}` : ""}` : "مفتوحة"}
          </span>
        </div>
        {visit.patientId === null ? <p className="mt-1 text-xs text-slate-600">زيارة غير مربوطة بملف مريض.</p> : null}
        {visit.referral ? <p className="mt-2 rounded-xl bg-sky-50 p-2 text-xs text-sky-900">محال{visit.referral.fromName ? ` من ${visit.referral.fromName}` : ""}: {visit.referral.reason}</p> : null}
        {!signed ? <p className="mt-2 text-xs text-slate-500">توقيع الزيارة من الحساب الموحّد لم يُفعَّل بعد.</p> : null}
      </section>

      {notice ? (
        <p role={notice.ok ? "status" : "alert"} data-testid="canonical-visit-notice"
          className={`rounded-xl p-3 text-sm font-semibold ${notice.ok ? "bg-emerald-50 text-emerald-800" : "bg-danger-50 text-danger-700"}`}>{notice.text}</p>
      ) : null}

      {visit.previousVisit || visit.latestDiagnosis ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm" data-testid="canonical-visit-history">
          <h3 className="mb-1 text-sm font-bold text-navy-900">ما سبق</h3>
          {visit.latestDiagnosis ? <p>آخر تشخيص ({visit.latestDiagnosis.date}): {visit.latestDiagnosis.text}</p> : null}
          {visit.previousVisit ? (
            <p className="mt-1 text-slate-700">الزيارة السابقة ({visit.previousVisit.date}): {visit.previousVisit.proceduresSummary ?? visit.previousVisit.treatmentDone ?? "—"}
              {visit.previousVisit.nextPlan ? ` · الخطة: ${visit.previousVisit.nextPlan}` : ""}</p>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="canonical-visit-notes">
        <h3 className="mb-2 text-sm font-bold text-navy-900">التوثيق</h3>
        {editable ? (
          <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void submit(notesBody, "حُفظ التوثيق."); }}>
            {NOTE_FIELDS.map(([key, label, max]) => (
              <label key={key} className="grid gap-1 text-xs font-bold text-slate-600">{label}
                <textarea value={notes[key]} maxLength={max} rows={key === "chiefComplaint" || key === "nextPlan" ? 2 : 3}
                  onChange={event => setNotes(current => current ? { ...current, [key]: event.target.value } : current)}
                  className="w-full rounded-xl border border-slate-300 p-2 text-sm font-normal text-navy-900" />
              </label>
            ))}
            <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">حفظ التوثيق</button>
          </form>
        ) : (
          <dl className="grid gap-2 text-sm">
            {NOTE_FIELDS.map(([key, label]) => (
              <div key={key}><dt className="text-xs font-bold text-slate-500">{label}</dt>
                <dd className="whitespace-pre-wrap text-navy-900">{visit[key] || "—"}</dd></div>
            ))}
          </dl>
        )}
        {visit.addendum ? <div className="mt-2 text-sm"><p className="text-xs font-bold text-slate-500">الملحق</p><p className="whitespace-pre-wrap" data-testid="canonical-visit-addendum">{visit.addendum}</p></div> : null}
        {canDocument && signed ? (
          <form className="mt-3 grid gap-2" onSubmit={async event => {
            event.preventDefault();
            if (await submit({ action: "addendum", text: addendum, requestKey: addendumKey }, "أُضيف الملحق.")) { setAddendum(""); setAddendumKey(newKey("visit-addendum")); }
          }}>
            <label className="grid gap-1 text-xs font-bold text-slate-600">ملحق على الزيارة الموقَّعة
              <textarea value={addendum} maxLength={1000} rows={2} onChange={event => setAddendum(event.target.value)}
                className="w-full rounded-xl border border-slate-300 p-2 text-sm font-normal text-navy-900" />
            </label>
            <button type="submit" disabled={busy || !addendum.trim()} className="min-h-11 rounded-xl border border-navy-900 px-4 text-sm font-bold text-navy-900 disabled:opacity-50">إضافة الملحق</button>
          </form>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="canonical-visit-procedures">
        <h3 className="mb-2 text-sm font-bold text-navy-900">الإجراءات</h3>
        {(editable ? drafts : visit.procedures).length === 0 ? <p className="text-sm text-slate-500">لا إجراءات مسجّلة.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {editable ? drafts.map(line => {
              const saved = visit.procedures.find(row => `saved-${row.id}` === line.key);
              return (
                <li key={line.key} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="canonical-visit-procedure">
                  <span>{line.serviceName}{line.toothCode ? ` — سن ${line.toothCode}` : ""}{line.surfaces ? ` (${line.surfaces})` : ""}{line.quantity > 1 ? ` × ${line.quantity}` : ""}</span>
                  <span className="flex items-center gap-2">
                    {saved && typeof saved.totalMinor === "number" ? <span className="font-bold tabular-nums" data-testid="canonical-visit-line-price">{formatMoney(saved.totalMinor, isCurrency(saved.planCurrency) ? saved.planCurrency : base)}</span> : null}
                    <button type="button" onClick={() => setDrafts(current => current.filter(row => row.key !== line.key))}
                      className="min-h-9 rounded-lg border border-slate-300 px-2 text-xs font-bold text-danger-700" aria-label={`حذف ${line.serviceName}`}>حذف</button>
                  </span>
                </li>
              );
            }) : visit.procedures.map(line => (
              <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="canonical-visit-procedure">
                <span>{line.serviceName}{line.toothCode ? ` — سن ${line.toothCode}` : ""}{line.surfaces ? ` (${line.surfaces})` : ""}{line.quantity > 1 ? ` × ${line.quantity}` : ""}</span>
                {typeof line.totalMinor === "number" ? (
                  <span className="font-bold tabular-nums" data-testid="canonical-visit-line-price">{formatMoney(line.totalMinor, isCurrency(line.planCurrency) ? line.planCurrency : base)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {showMoney && !draftsChanged ? <p className="mt-2 text-sm font-bold" data-testid="canonical-visit-total">المجموع: {formatMoney(visit.totalMinor!, base)}</p> : null}
        {editable && draftsChanged ? (
          <button type="button" disabled={busy} onClick={() => void submit(proceduresBody, "حُفظت الإجراءات والتوثيق.")}
            className="mt-2 min-h-11 w-full rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">حفظ الإجراءات</button>
        ) : null}
      </section>

      {visit.outstanding.length > 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="canonical-visit-outstanding">
          <h3 className="mb-2 text-sm font-bold text-navy-900">العلاج المتبقّي</h3>
          <ul className="space-y-2 text-sm">
            {visit.outstanding.map(item => (
              <li key={item.planItemId} className="flex flex-wrap items-center justify-between gap-2">
                <span>{item.serviceName}{item.toothCode ? ` — سن ${item.toothCode}` : ""} · {item.planTitle} · {item.doneSessions}/{item.sessionCount}
                  {item.unmetRequirements.length > 0 ? <span className="text-amber-700"> · يتطلب: {item.unmetRequirements.join("، ")}</span> : null}</span>
                {editable && item.serviceId !== null && remainingSessions(item) > 0 ? (
                  <button type="button" onClick={() => setDrafts(current => [...current, {
                    key: newKey("plan"), serviceId: item.serviceId!, serviceName: item.serviceName, toothCode: item.toothCode, surfaces: item.surfaces ?? null,
                    quantity: 1, doctorId: visit.doctorId, planItemId: item.planItemId, note: null,
                  }])} className="min-h-9 rounded-lg border border-navy-900 px-2 text-xs font-bold text-navy-900">إضافة لهذه الزيارة</button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {visit.activeCases.length > 0 || visit.labOrders.length > 0 || visit.ortho ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm" data-testid="canonical-visit-context">
          {visit.ortho ? <p data-testid="canonical-visit-ortho">التقويم: {visit.ortho.appliance} · {visit.ortho.phase}
            {visit.ortho.upperWire || visit.ortho.lowerWire ? ` · الأسلاك ${visit.ortho.upperWire ?? "—"} / ${visit.ortho.lowerWire ?? "—"}` : ""}</p> : null}
          {visit.activeCases.map(one => <p key={`${one.kind}-${one.id ?? one.title}`}>{one.title}{one.nextStep ? ` — التالي: ${one.nextStep}` : ""}</p>)}
          {visit.labOrders.map(order => <p key={order.id}>مختبر: {order.workType}{order.toothCode ? ` — سن ${order.toothCode}` : ""} · {order.labName}</p>)}
        </section>
      ) : null}
    </div>
  );
}
