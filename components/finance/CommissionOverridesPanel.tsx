"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * (COMM-DETAIL-1 · F-11) النسبة الخاصة بالحالة — للمدير وحده.
 *
 * «٢٥٪ لحالة محمد أحمد لدى د. يوسف»: يُختار المريض ثم حالته التخصصية (أو خطة علاجه) ثم
 * الطبيب والنسبة وتاريخ السريان والسبب (إلزامي). لا صفَّ يُعدَّل: التغيير والإلغاء صفٌّ جديد
 * يخلف السابق، ويظهر السجل كاملًا. الحساب يقرؤها وقت كل حدث في المحرّك نفسه.
 */

interface OverrideView {
  id: number; doctorId: number; doctorName: string; caseId: number | null; planId: number | null;
  targetLabel: string; patientName: string | null; percent: number | null; action: "set" | "void";
  reason: string; effectiveFrom: string; supersedesId: number | null; isHead: boolean; createdBy: string;
}
interface Targets {
  cases: Array<{ id: number; title: string; specialty: string; status: string }>;
  plans: Array<{ id: number; title: string | null; status: string | null }>;
  doctors: Array<{ id: number; name: string }>;
}

export function CommissionOverridesPanel({ today }: { today: string }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [matches, setMatches] = useState<Array<{ id: number; fullName: string; patientNumber: string }>>([]);
  const [patientId, setPatientId] = useState<number | null>(null);
  const [overrides, setOverrides] = useState<OverrideView[]>([]);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [target, setTarget] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [percent, setPercent] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async (patient: number | null) => {
    const response = await fetch(`/api/finance/commission-overrides${patient ? `?patientId=${patient}` : ""}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setMessage({ kind: "error", text: payload?.message ?? "تعذّر التحميل." });
      return;
    }
    setOverrides(payload.overrides as OverrideView[]);
    setTargets(payload.targets as Targets | null);
  }, []);

  useEffect(() => { if (open) void load(patientId); }, [open, patientId, load]);

  const search = async () => {
    if (!term.trim()) return;
    const response = await fetch(`/api/patients?q=${encodeURIComponent(term.trim())}`, { cache: "no-store" });
    const payload = await response.json().catch(() => []);
    setMatches(Array.isArray(payload) ? payload.slice(0, 8) : []);
  };

  const [kind, rawId] = target.split(":");
  const caseId = kind === "c" ? Number(rawId) : null;
  const planId = kind === "p" ? Number(rawId) : null;
  const head = overrides.find((row) => row.isHead && row.doctorId === Number(doctorId)
    && ((caseId !== null && row.caseId === caseId) || (planId !== null && row.planId === planId)));

  const submit = async (action: "set" | "void", supersedes: OverrideView | undefined) => {
    setBusy(true);
    setMessage(null);
    try {
      const source = action === "void" ? supersedes! : null;
      const response = await fetch("/api/finance/commission-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doctorId: source ? source.doctorId : Number(doctorId),
          caseId: source ? source.caseId : caseId,
          planId: source ? source.planId : planId,
          action,
          percent: action === "set" ? Number(percent) : null,
          reason,
          effectiveDate: effectiveDate || null,
          supersedesId: supersedes?.id ?? null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الحفظ.");
      setMessage({ kind: "ok", text: action === "set" ? "حُفظت النسبة الخاصة." : "أُلغيت النسبة الخاصة." });
      setReason("");
      await load(patientId);
    } catch (saveError) {
      setMessage({ kind: "error", text: saveError instanceof Error ? saveError.message : "تعذّر الحفظ." });
    } finally {
      setBusy(false);
    }
  };

  const canSave = Boolean(doctorId && target && percent !== "" && reason.trim().length >= 3 && !busy);

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="flex w-full items-center justify-between text-sm font-extrabold text-navy-800">
        <span>نسب خاصة بالحالات (المدير)</span>
        <span className="text-xs text-slate-500">{open ? "إخفاء" : "عرض"}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-3 text-xs">
          <div className="flex gap-2">
            <input value={term} onChange={(event) => setTerm(event.target.value)} placeholder="ابحث عن المريض بالاسم أو الرقم"
              onKeyDown={(event) => { if (event.key === "Enter") void search(); }}
              className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            <button type="button" onClick={() => void search()} className="rounded-xl bg-navy-800 px-3 py-2 font-bold text-white">بحث</button>
          </div>
          {matches.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {matches.map((patient) => (
                <li key={patient.id}>
                  <button type="button" onClick={() => { setPatientId(patient.id); setMatches([]); setTarget(""); }}
                    className={`rounded-xl border px-2 py-1 ${patientId === patient.id ? "border-navy-800 bg-navy-50" : "border-slate-200"}`}>
                    {patient.fullName} <span className="text-slate-400">{patient.patientNumber}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {patientId && targets ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label>
                <span className="mb-1 block font-bold text-slate-500">الحالة أو الخطة</span>
                <select value={target} onChange={(event) => setTarget(event.target.value)} className="w-full rounded-xl border border-slate-200 px-2 py-2 text-sm">
                  <option value="">اختر…</option>
                  {targets.cases.map((item) => <option key={`c${item.id}`} value={`c:${item.id}`}>حالة: {item.title} ({item.specialty})</option>)}
                  {targets.plans.map((item) => <option key={`p${item.id}`} value={`p:${item.id}`}>خطة: {item.title ?? `#${item.id}`}</option>)}
                </select>
              </label>
              <label>
                <span className="mb-1 block font-bold text-slate-500">الطبيب المعالج</span>
                <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)} className="w-full rounded-xl border border-slate-200 px-2 py-2 text-sm">
                  <option value="">اختر…</option>
                  {targets.doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
                </select>
              </label>
              <label>
                <span className="mb-1 block font-bold text-slate-500">النسبة ٪</span>
                <input type="number" min={0} max={100} step={0.5} value={percent} onChange={(event) => setPercent(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-2 py-2 text-sm" />
              </label>
              <label>
                <span className="mb-1 block font-bold text-slate-500">تسري من</span>
                <input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-2 py-2 text-sm" />
              </label>
              <label className="sm:col-span-2">
                <span className="mb-1 block font-bold text-slate-500">السبب (إلزامي)</span>
                <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500}
                  className="w-full rounded-xl border border-slate-200 px-2 py-2 text-sm" />
              </label>
              <button type="button" disabled={!canSave} onClick={() => void submit("set", head)}
                className="rounded-xl bg-brand-orange py-2 font-bold text-white disabled:opacity-50 sm:col-span-2">
                {head ? "استبدال النسبة الخاصة السارية" : "حفظ النسبة الخاصة"}
              </button>
            </div>
          ) : null}
          {message ? (
            <p role={message.kind === "error" ? "alert" : "status"}
              className={`rounded-xl px-3 py-2 ${message.kind === "error" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>
              {message.text}
            </p>
          ) : null}
          <ul className="space-y-1.5">
            {overrides.length === 0 ? <li className="text-center text-slate-400">لا نسب خاصة مسجّلة{patientId ? " لهذا المريض" : ""}.</li> : null}
            {overrides.map((row) => (
              <li key={row.id} className={`rounded-xl border p-2 ${row.isHead ? "border-slate-300" : "border-slate-100 text-slate-400"}`}>
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="font-bold">{row.doctorName} — {row.targetLabel}{row.patientName ? ` — ${row.patientName}` : ""}</span>
                  <span>{row.action === "set" ? `${row.percent}٪` : "إلغاء"} · من {row.effectiveFrom.slice(0, 10)}</span>
                </div>
                <p>السبب: {row.reason} · {row.createdBy}{row.supersedesId ? ` · يخلف #${row.supersedesId}` : ""}</p>
                {row.isHead && row.action === "set" ? (
                  <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void submit("void", row)}
                    className="mt-1 rounded-lg border border-red-300 px-2 py-0.5 text-red-700 disabled:opacity-50"
                    title="اكتب السبب في الحقل أعلاه ثم ألغِ">
                    إلغاء هذه النسبة (بسبب مكتوب)
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
