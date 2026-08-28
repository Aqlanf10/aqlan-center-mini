"use client";

import { useCallback, useEffect, useState } from "react";
import {
  APPLIANCE_LABEL, ARCHES_LABEL, CASE_STATUS_LABEL, ELASTIC_LABEL, PHASE_HINT,
  PHASE_LABEL, PHASE_ORDER, RETAINER_LABEL, SLOT_LABEL,
  nextAdjustmentDate, nextWire, usesArchwires, wiresFor,
  type Appliance, type Arches, type CaseStatus, type ElasticClass,
  type OrthoPhase, type RetainerType, type SlotSize,
} from "@/lib/ortho";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";

/**
 * ملفّ التقويم.
 *
 * الشاشة التي تجيب في ثلاث ثوانٍ على الكرسي: **على أيّ سلكٍ هو، وماذا عُمل له آخر
 * مرة، ومتى أراه؟** وترتيبها يتبع ذلك: السلكان أولًا وبأكبر خطّ، ثم المرحلة
 * والمدة، ثم سجلّ الشدّات تحتهما.
 */

interface Adjustment {
  id: number; visitId: number | null; doneOn: string; phase: OrthoPhase | null;
  upperWire: string | null; lowerWire: string | null; elastics: ElasticClass;
  elasticNote: string | null; done: string | null; nextWeeks: number;
  note: string | null; recordedBy: string;
}

interface OrthoCase {
  id: number; appliance: Appliance; arches: Arches; slot: SlotSize;
  bracketSystem: string | null; status: CaseStatus; phase: OrthoPhase;
  startDate: string; plannedMonths: number;
  upperWire: string | null; lowerWire: string | null;
  retainer: RetainerType | null; retainerOn: string | null; note: string | null;
  closedAt: string | null; closedBy: string | null; closedNote: string | null;
  adjustments: Adjustment[];
  progress: {
    monthsElapsed: number; monthsPlanned: number; monthsRemaining: number;
    percent: number; overdue: boolean; adjustments: number;
    lastAdjustment: string | null; daysSinceLast: number | null;
  };
}

/** «٠ شهر» و«١ شهر» ركاكة — والعربية لها مثنّى وجمعُ قلّة. */
function monthsText(months: number): string {
  if (months < 1) return "أقل من شهر";
  const whole = Math.round(months);
  if (whole === 1) return "شهر";
  if (whole === 2) return "شهران";
  if (whole <= 10) return `${whole} أشهر`;
  return `${whole} شهرًا`;
}

/** «قبل ١ يومًا» ركاكةٌ تُقرأ في كل مرة — والعربية لها مثنّى وجمعُ قلّة. */
function daysText(days: number): string {
  if (days === 1) return "قبل يوم";
  if (days === 2) return "قبل يومين";
  if (days <= 10) return `قبل ${days} أيام`;
  return `قبل ${days} يومًا`;
}

export function PatientOrtho({ patientId }: { patientId: number }) {
  const today = clinicDateString(new Date(), "Asia/Aden");
  const [cases, setCases] = useState<OrthoCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [adjusting, setAdjusting] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/ortho?patientId=${patientId}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setCases(payload.cases as OrthoCase[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const open = cases.find((row) => row.status === "active" || row.status === "retention");

  const patch = async (id: number, body: Record<string, unknown>) => {
    const response = await fetch(`/api/ortho/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) { setError(payload?.message ?? "تعذّر التنفيذ."); return false; }
    setError(null);
    await load();
    return true;
  };

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {!open ? (
        <>
          <button onClick={() => setOpening((value) => !value)}
            className="mb-3 w-full rounded-2xl bg-navy-800 py-2.5 text-sm font-extrabold text-white">
            {opening ? "إغلاق" : "+ افتح حالة تقويم"}
          </button>
          {opening ? (
            <NewCase patientId={patientId} today={today}
              onSaved={() => { setOpening(false); void load(); }} onError={setError} />
          ) : null}
        </>
      ) : null}

      {loading && cases.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : cases.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا حالة تقويم لهذا المريض.
        </p>
      ) : (
        <ul className="space-y-3">
          {cases.map((row) => {
            const live = row.status === "active" || row.status === "retention";
            const wires = wiresFor(row.slot);
            return (
              <li key={row.id} className={`rounded-2xl border p-4 ${
                live ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
              }`}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-base font-extrabold">
                    {APPLIANCE_LABEL[row.appliance]} · {ARCHES_LABEL[row.arches]}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
                    {CASE_STATUS_LABEL[row.status]}
                  </span>
                </div>

                {/* السلكان أولًا وبأكبر خطّ — أول ما يحتاجه الطبيب قبل أن يفتح الفم. */}
                {usesArchwires(row.appliance) ? (
                  <div className="mb-3 grid grid-cols-2 gap-2 text-center">
                    <div className="rounded-xl bg-navy-50 p-2.5">
                      <p className="text-base font-extrabold text-navy-900" dir="ltr">
                        {row.upperWire ?? "—"}
                      </p>
                      <p className="text-[11px] text-slate-500">السلك العلوي</p>
                    </div>
                    <div className="rounded-xl bg-navy-50 p-2.5">
                      <p className="text-base font-extrabold text-navy-900" dir="ltr">
                        {row.lowerWire ?? "—"}
                      </p>
                      <p className="text-[11px] text-slate-500">السلك السفلي</p>
                    </div>
                  </div>
                ) : null}

                <div className="mb-2 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-slate-50 p-2">
                    <p className="text-sm font-bold">{monthsText(row.progress.monthsElapsed)}</p>
                    <p className="text-[11px] text-slate-500">مضى</p>
                  </div>
                  <div className={`rounded-xl p-2 ${row.progress.overdue ? "bg-amber-50" : "bg-slate-50"}`}>
                    <p className={`text-sm font-bold ${row.progress.overdue ? "text-amber-800" : ""}`}>
                      {row.progress.overdue ? "تجاوزت" : monthsText(row.progress.monthsRemaining)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {row.progress.overdue ? `المتوقّع ${row.plannedMonths} شهرًا` : "متبقٍّ"}
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2">
                    <p className="text-sm font-bold">{row.progress.adjustments}</p>
                    <p className="text-[11px] text-slate-500">شدّة</p>
                  </div>
                </div>

                <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full ${row.progress.overdue ? "bg-amber-500" : "bg-navy-700"}`}
                    style={{ width: `${row.progress.percent}%` }} />
                </div>

                <p className="mb-2 text-[11px] text-slate-500">
                  بدأت {friendlyDateLong(row.startDate)}
                  {row.bracketSystem ? ` · ${row.bracketSystem}` : ""} · {SLOT_LABEL[row.slot]}
                  {row.progress.lastAdjustment
                    ? ` · آخر شدّ ${friendlyDateLong(row.progress.lastAdjustment)}${
                        row.progress.daysSinceLast !== null && row.progress.daysSinceLast > 0
                          ? ` (${daysText(row.progress.daysSinceLast)})` : " (اليوم)"}`
                    : " · لا شدّات بعد"}
                </p>

                {live ? (
                  <>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {PHASE_ORDER.map((phase) => (
                        <button key={phase} onClick={() => void patch(row.id, { phase })}
                          title={PHASE_HINT[phase]}
                          className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
                            row.phase === phase
                              ? "border-navy-800 bg-navy-800 text-white"
                              : "border-slate-200 bg-white text-slate-600"
                          }`}>
                          {PHASE_LABEL[phase]}
                        </button>
                      ))}
                    </div>

                    {adjusting === row.id ? (
                      <AdjustmentForm caseRow={row} today={today} wires={wires}
                        onSaved={() => { setAdjusting(null); void load(); }} onError={setError} />
                    ) : (
                      <button onClick={() => setAdjusting(row.id)}
                        className="w-full rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white">
                        سجّل شدّة
                      </button>
                    )}

                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
                        المثبّت وإغلاق الحالة
                      </summary>
                      <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <p className="mb-1.5 text-[11px] font-bold text-slate-500">
                          المثبّت: {row.retainer ? RETAINER_LABEL[row.retainer] : "لم يُسجَّل"}
                          {row.retainerOn ? ` · ${friendlyDateLong(row.retainerOn)}` : ""}
                        </p>
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {(Object.keys(RETAINER_LABEL) as RetainerType[]).map((type) => (
                            <button key={type} onClick={() => void patch(row.id, { retainer: type })}
                              className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
                                row.retainer === type
                                  ? "border-emerald-600 bg-emerald-600 text-white"
                                  : "border-slate-200 bg-white text-slate-600"
                              }`}>
                              {RETAINER_LABEL[type]}
                            </button>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={async () => {
                              const note = window.prompt("ملاحظة على إكمال الحالة (اختياري)") ?? "";
                              await patch(row.id, { status: "completed", note });
                            }}
                            className="flex-1 rounded-xl bg-emerald-600 py-2 text-xs font-extrabold text-white">
                            أكملت الحالة
                          </button>
                          <button
                            onClick={async () => {
                              const note = window.prompt("سبب التوقّف؟");
                              if (!note?.trim()) return;
                              await patch(row.id, { status: "discontinued", note });
                            }}
                            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-600">
                            توقّفت
                          </button>
                        </div>
                      </div>
                    </details>
                  </>
                ) : row.closedAt ? (
                  <p className="text-[11px] text-slate-500">
                    أُغلقت {friendlyDateLong(row.closedAt.slice(0, 10))} بيد {row.closedBy}
                    {row.closedNote ? ` · ${row.closedNote}` : ""}
                  </p>
                ) : null}

                {row.adjustments.length > 0 ? (
                  <details className="mt-2" open={live}>
                    <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
                      سجلّ الشدّات ({row.adjustments.length})
                    </summary>
                    <ul className="mt-2 space-y-1.5">
                      {row.adjustments.map((entry) => (
                        <li key={entry.id} className="rounded-xl bg-slate-50 px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-bold">{friendlyDateLong(entry.doneOn)}</span>
                            {/* موسومان هنا كما في شاشة الزيارة — «014 / 012» وحدها
                                لا تقول أيّهما العلوي، والسجل يُقرأ بعد سنة. */}
                            <span className="text-[11px] text-slate-500">
                              {entry.upperWire || entry.lowerWire ? (
                                <>
                                  علوي <span dir="ltr">{entry.upperWire ?? "—"}</span>
                                  {" · "}سفلي <span dir="ltr">{entry.lowerWire ?? "—"}</span>
                                </>
                              ) : "—"}
                            </span>
                          </div>
                          {entry.done ? <p className="mt-0.5 text-[11px] text-slate-600">{entry.done}</p> : null}
                          <p className="mt-0.5 text-[10px] text-slate-400">
                            {ELASTIC_LABEL[entry.elastics]}
                            {entry.elasticNote ? ` · ${entry.elasticNote}` : ""}
                            {" · القادم "}{friendlyDateLong(nextAdjustmentDate(entry.doneOn, entry.nextWeeks))}
                            {" · "}{entry.recordedBy}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NewCase({ patientId, today, onSaved, onError }: {
  patientId: number; today: string; onSaved: () => void; onError: (message: string | null) => void;
}) {
  const [appliance, setAppliance] = useState<Appliance>("fixed_metal");
  const [arches, setArches] = useState<Arches>("both");
  const [slot, setSlot] = useState<SlotSize>("022");
  const [bracketSystem, setBracketSystem] = useState("MBT");
  const [startDate, setStartDate] = useState(today);
  const [plannedMonths, setPlannedMonths] = useState("18");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      const response = await fetch("/api/ortho", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId, appliance, arches, slot, bracketSystem, startDate,
          plannedMonths: Number(plannedMonths) || 18,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر الفتح."); return; }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-3 rounded-2xl border border-navy-800 bg-white p-4">
      <h3 className="mb-3 text-sm font-bold">حالة تقويم جديدة</h3>
      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الجهاز</span>
          <select value={appliance} onChange={(event) => setAppliance(event.target.value as Appliance)}
            aria-label="نوع الجهاز"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(APPLIANCE_LABEL) as Appliance[]).map((value) => (
              <option key={value} value={value}>{APPLIANCE_LABEL[value]}</option>
            ))}
          </select>
        </label>
        <label className="min-w-[7rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الفكّان</span>
          <select value={arches} onChange={(event) => setArches(event.target.value as Arches)}
            aria-label="الفكّان المعالَجان"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(ARCHES_LABEL) as Arches[]).map((value) => (
              <option key={value} value={value}>{ARCHES_LABEL[value]}</option>
            ))}
          </select>
        </label>
      </div>

      {usesArchwires(appliance) ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <label className="min-w-[7rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">الشقّ</span>
            <select value={slot} onChange={(event) => setSlot(event.target.value as SlotSize)}
              aria-label="مقاس الشقّ"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              {(Object.keys(SLOT_LABEL) as SlotSize[]).map((value) => (
                <option key={value} value={value}>{SLOT_LABEL[value]}</option>
              ))}
            </select>
          </label>
          <label className="min-w-[8rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">نظام البراكيت</span>
            <input value={bracketSystem} onChange={(event) => setBracketSystem(event.target.value)}
              aria-label="نظام البراكيت" dir="ltr"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">تاريخ البدء</span>
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}
            aria-label="تاريخ بدء التقويم"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label className="w-32">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">المدة (أشهر)</span>
          <input value={plannedMonths} onChange={(event) => setPlannedMonths(event.target.value)}
            aria-label="المدة المتوقعة" inputMode="numeric" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
      </div>

      <button type="submit" disabled={saving}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
        افتح الحالة
      </button>
    </form>
  );
}

function AdjustmentForm({ caseRow, today, wires, onSaved, onError }: {
  caseRow: OrthoCase; today: string;
  wires: { code: string }[];
  onSaved: () => void; onError: (message: string | null) => void;
}) {
  // المقترح هو التالي في التسلسل — ويُقبل غيره بلا اعتراض: الطبيب أخصائي، وحالةٌ
  // بعينها قد تستدعي البقاء على السلك نفسه شهرين أو الرجوع خطوة.
  const suggestedUpper = nextWire(caseRow.slot, caseRow.upperWire)?.code ?? caseRow.upperWire ?? "";
  const suggestedLower = nextWire(caseRow.slot, caseRow.lowerWire)?.code ?? caseRow.lowerWire ?? "";

  const [doneOn, setDoneOn] = useState(today);
  const [upperWire, setUpperWire] = useState(suggestedUpper);
  const [lowerWire, setLowerWire] = useState(suggestedLower);
  const [elastics, setElastics] = useState<ElasticClass>("none");
  const [elasticNote, setElasticNote] = useState("");
  const [done, setDone] = useState("");
  const [nextWeeks, setNextWeeks] = useState("4");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      const response = await fetch(`/api/ortho/${caseRow.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doneOn, upperWire, lowerWire, elastics, elasticNote, done,
          nextWeeks: Number(nextWeeks) || 4,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر التسجيل."); return; }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  const options = [...new Set([...wires.map((wire) => wire.code),
    caseRow.upperWire, caseRow.lowerWire].filter(Boolean) as string[])];

  return (
    <form onSubmit={submit} className="rounded-xl border border-brand-orange bg-orange-50 p-3">
      <p className="mb-2 text-xs font-bold text-slate-700">شدّة جديدة</p>

      {usesArchwires(caseRow.appliance) ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">
              السلك العلوي {caseRow.upperWire ? `(الحالي ${caseRow.upperWire})` : ""}
            </span>
            <select value={upperWire} onChange={(event) => setUpperWire(event.target.value)}
              aria-label="السلك العلوي" dir="ltr"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              <option value="">— بلا تغيير —</option>
              {options.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">
              السلك السفلي {caseRow.lowerWire ? `(الحالي ${caseRow.lowerWire})` : ""}
            </span>
            <select value={lowerWire} onChange={(event) => setLowerWire(event.target.value)}
              aria-label="السلك السفلي" dir="ltr"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              <option value="">— بلا تغيير —</option>
              {options.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
        </div>
      ) : null}

      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">المطاطات</span>
          <select value={elastics} onChange={(event) => setElastics(event.target.value as ElasticClass)}
            aria-label="صنف المطاطات"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(ELASTIC_LABEL) as ElasticClass[]).map((value) => (
              <option key={value} value={value}>{ELASTIC_LABEL[value]}</option>
            ))}
          </select>
        </label>
        {elastics !== "none" ? (
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">وصف المطاطات</span>
            <input value={elasticNote} onChange={(event) => setElasticNote(event.target.value)}
              aria-label="وصف المطاطات" placeholder="3/16 خفيفة — ليلًا"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
        ) : null}
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] font-bold text-slate-500">ما نُفّذ</span>
        <input value={done} onChange={(event) => setDone(event.target.value)}
          aria-label="ما نُفّذ في الشدّة" placeholder="تبديل السلك وربط الأربطة"
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
      </label>

      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">تاريخ الشدّة</span>
          <input type="date" value={doneOn} onChange={(event) => setDoneOn(event.target.value)}
            aria-label="تاريخ الشدّة"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label className="w-36">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">القادمة بعد (أسابيع)</span>
          <input value={nextWeeks} onChange={(event) => setNextWeeks(event.target.value)}
            aria-label="أسابيع حتى الشدّة القادمة" inputMode="numeric" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
      </div>

      <p className="mb-2 text-[10px] text-slate-500">
        القادمة {friendlyDateLong(nextAdjustmentDate(doneOn, Number(nextWeeks) || 4))}
      </p>

      <button type="submit" disabled={saving}
        className="w-full rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
        احفظ الشدّة
      </button>
    </form>
  );
}
