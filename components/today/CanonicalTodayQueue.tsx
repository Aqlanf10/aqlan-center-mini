"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { chairRows, daySummary, firstFreeChair, waitingRows, type Visit, type WaitLevel } from "@/lib/flow";
import { useChairCount, useNumberSetting } from "@/components/SettingsProvider";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { sendGatedMove } from "@/components/today/useChairReadiness";
import { formatMoney, type Currency } from "@/lib/money";
import { CanonicalDisplayNotice } from "./CanonicalDisplayNotice";
import { CanonicalNextSession } from "../patient/CanonicalNextSession";
import { useSession } from "../SessionProvider";

/**
 * قائمة اليوم لجلسة الهوية الموحّدة (M2 slices 11–12).
 *
 * قراءة واحدة: GET /api/visits يعيد زيارات اليوم ضمن نطاق مرضاك فقط، وملاحظة الوصول
 * لمن يملك الملخص التشغيلي. التسجيل والنداء والإجلاس والإنهاء تظهر لمن يملك visits.manage،
 * والخادم يتحقق منها مجددًا في كل حركة (PATCH /api/visits/[id]).
 * لا تُستدعى مسارات قديمة (جاهزية الكرسي، التسليم، المواعيد) حتى تُنقل.
 */
interface QueueView { visits: (Visit & { note?: string | null })[]; projection: { note: boolean }; canManage: boolean }
interface ReadinessRow {
  visitId: number;
  cleared: { at: string; by: string | null } | null;
  checklist?: { key: string; state: "ok" | "attention" | "info"; label: string }[];
  attention?: number;
  balances?: { currency: Currency; dueMinor: number; warn: boolean }[];
}
interface ReadinessView { requireClearance: boolean; items: ReadinessRow[] }
interface PatientMatch { id: number; patientNumber: string; fullName: string; phone: string | null }

const LEVEL_CLASS: Record<WaitLevel, string> = {
  calm: "border-slate-200 bg-white",
  warning: "border-amber-300 bg-amber-50",
  critical: "border-red-300 bg-red-50",
};
const POLL_MS = 20_000;
const MOVE_DONE = {
  call: (name: string, chair?: number) => `نُودي على ${name} إلى كرسي ${chair}.`,
  seat: (name: string, chair?: number) => `جلس ${name} على كرسي ${chair}.`,
  call_again: (name: string) => `أُعيد النداء على ${name}.`,
  return: (name: string) => `عاد ${name} إلى الانتظار.`,
  finish: (name: string) => `انتهت زيارة ${name}.`,
  clear: (name: string) => `أُقِرّت جاهزية ${name}.`,
} as const;
/** ساعة الوصول بتوقيت العيادة لا بساعة الجهاز. */
const arrivalTime = (iso: string) => new Date(iso).toLocaleTimeString("ar-YE", { timeZone: CLINIC_ZONE_FALLBACK, hour: "2-digit", minute: "2-digit", hour12: true });

export function CanonicalTodayQueue() {
  const session = useSession();
  const canBook = session?.isOwner === true || session?.capabilities?.includes("appointments.create") === true
    && session.patientScope !== "none" && session.appointmentScope !== "none";
  const [view, setView] = useState<QueueView | null>(null);
  const [readiness, setReadiness] = useState<ReadinessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const chairCount = useChairCount();
  const thresholds = { warningMinutes: useNumberSetting("ops.wait_warning_minutes"), criticalMinutes: useNumberSetting("ops.wait_critical_minutes") };

  // Every reload (poll, refresh button, after an arrival) bumps the version.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(current => current + 1), []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/visits", { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) { setError(payload?.message ?? "تعذّر تحميل قائمة اليوم."); return; }
        setView(payload as QueueView);
        setError(null);
        setNow(new Date());
        // الجاهزية قراءةٌ ثانية مستقلة: فشلها لا يُسقط القائمة، ويُخفي الشارات فقط.
        const ready = await fetch("/api/visits/readiness", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);
        if (!cancelled) setReadiness(ready as ReadinessView | null);
      } catch { if (!cancelled) setError("تعذّر الاتصال بالخادم. القائمة المعروضة قد لا تكون محدّثة."); }
    })();
    return () => { cancelled = true; };
  }, [version]);
  useEffect(() => {
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const visits = view?.visits ?? [];
  const summary = daySummary(chairCount, visits, now);
  const waiting = waitingRows(visits, now, thresholds);
  const chairs = chairRows(chairCount, visits, now);
  const freeChair = firstFreeChair(chairCount, visits);
  const [moveMessage, setMoveMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [moving, setMoving] = useState(false);
  /** حركة طابور واحدة: النداء والإجلاس عبر بوابة الجاهزية (سبب طوارئ مكتوب عند المنع). */
  const readinessOf = (visitId: number) => readiness?.items.find(item => item.visitId === visitId) ?? null;
  async function move(visit: Visit, action: "call" | "seat" | "call_again" | "return" | "finish" | "clear", chair?: number) {
    setMoving(true); setMoveMessage(null);
    try {
      const response = action === "call" || action === "seat"
        ? await sendGatedMove(visit.id, { action, chair: chair! })
        : await fetch(`/api/visits/${visit.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMoveMessage({ ok: false, text: payload?.message ?? "تعذّر تنفيذ الإجراء." }); return; }
      setMoveMessage({ ok: true, text: payload?.warning ?? MOVE_DONE[action](visit.patientName, chair) });
    } catch { setMoveMessage({ ok: false, text: "تعذّر الاتصال بالخادم. لم تُعتبر الحركة منفّذة؛ حدّث القائمة." }); }
    finally { setMoving(false); reload(); }
  }
  const actionButton = (label: string, onClick: () => void) => (
    <button type="button" disabled={moving} onClick={onClick}
      className="min-h-11 rounded-xl border border-navy-300 bg-white px-3 text-xs font-bold text-navy-900 disabled:opacity-50">{label}</button>
  );
  return (
    <section aria-labelledby="today-queue-title" className="mx-auto max-w-4xl space-y-4" data-testid="canonical-today-queue">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 id="today-queue-title" className="text-lg font-black text-navy-900">قائمة اليوم</h1>
        <button type="button" onClick={reload} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">تحديث</button>
      </header>
      <CanonicalDisplayNotice />
      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {view ? (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="queue-summary">
            {([["ينتظرون", summary.waiting], ["على الكرسي", summary.inChair], ["أطول انتظار", `${summary.longestWaitMinutes} د`], ["كراسي فارغة", summary.freeChairs]] as const).map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-slate-200 bg-white p-3">
                <dt className="text-xs font-semibold text-slate-600">{label}</dt>
                <dd className="text-xl font-black text-navy-900">{value}</dd>
              </div>
            ))}
          </dl>
          {view.canManage ? <ArrivalForm onArrived={reload} /> : null}
          {moveMessage ? <p role={moveMessage.ok ? "status" : "alert"} data-testid="move-message" className={`rounded-xl border p-3 text-sm ${moveMessage.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>{moveMessage.text}</p> : null}
          <section aria-labelledby="waiting-title" className="space-y-2">
            <h2 id="waiting-title" className="text-sm font-bold text-navy-900">المنتظرون ({waiting.length})</h2>
            {waiting.length === 0 ? <p className="text-sm text-slate-600">لا أحد ينتظر الآن.</p> : (
              <ul className="space-y-2" data-testid="waiting-list">
                {waiting.map(row => (
                  <li key={row.visit.id} className={`rounded-2xl border p-3 ${LEVEL_CLASS[row.level]}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-bold text-navy-900">{row.visit.patientName}</span>
                      <span className="text-xs font-semibold text-slate-700">ينتظر منذ {row.waitedMinutes} د — وصل {arrivalTime(row.visit.arrivedAt)}</span>
                    </div>
                    {view.projection.note && row.visit.note ? <p className="mt-1 text-xs text-slate-700">{row.visit.note}</p> : null}
                    <ReadinessBadge row={readinessOf(row.visit.id)} />
                    {view.canManage && readiness && !readinessOf(row.visit.id)?.cleared ? (
                      <div className="mt-2">{actionButton("أقِرّ الجاهزية", () => void move(row.visit, "clear"))}</div>
                    ) : null}
                    {view.canManage && freeChair !== null ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {actionButton(`نداء إلى كرسي ${freeChair}`, () => void move(row.visit, "call", freeChair))}
                        {actionButton(`إجلاس على كرسي ${freeChair}`, () => void move(row.visit, "seat", freeChair))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="chairs-title" className="space-y-2">
            <h2 id="chairs-title" className="text-sm font-bold text-navy-900">الكراسي</h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {chairs.map(row => (
                <li key={row.chair} className="rounded-2xl border border-slate-200 bg-white p-3 text-sm" data-testid={`chair-${row.chair}`}>
                  <span className="font-bold text-navy-900">كرسي {row.chair}: </span>
                  {row.occupant ? `${row.occupant.patientName} — منذ ${row.busyMinutes} د`
                    : row.calledFor ? `نُودي على ${row.calledFor.patientName}` : "فارغ"}
                  {view.canManage && row.occupant ? (
                    <div className="mt-2 flex flex-wrap gap-2">{actionButton("انتهى", () => void move(row.occupant!, "finish"))}</div>
                  ) : null}
                  {view.canManage && row.calledFor ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {actionButton("جلس", () => void move(row.calledFor!, "seat", row.chair))}
                      {actionButton("إعادة النداء", () => void move(row.calledFor!, "call_again"))}
                      {actionButton("لم يحضر — للانتظار", () => void move(row.calledFor!, "return"))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          {canBook && visits.some(visit => visit.status === "done" && visit.patientId) ? <section aria-label="حجز العودة بعد الزيارة" className="space-y-2">
            <h2 className="text-sm font-bold text-navy-900">الجلسة القادمة بعد الزيارة</h2>
            {visits.filter(visit => visit.status === "done" && visit.patientId).map(visit => <div key={visit.id} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3">
              <p className="mb-2 text-sm font-bold text-navy-900">{visit.patientName}</p>
              <CanonicalNextSession visitId={visit.id} patientId={visit.patientId!} />
            </div>)}
          </section> : null}
          <p className="text-xs text-slate-600">
            القائمة تتحدّث كل عشرين ثانية.{readiness?.requireClearance ? " إعداد المركز يمنع النداء قبل إقرار الجاهزية إلا طوارئ بسببٍ مكتوب." : ""}
          </p>
        </>
      ) : error ? null : <p role="status" className="text-sm text-slate-600">جارٍ تحميل قائمة اليوم…</p>}
    </section>
  );
}

/** جاهزية الكرسي كما أسقطها الخادم: القائمة لمن يملك الملخص أو الصلاحية السريرية، والرصيد لمن يرى الحساب. */
function ReadinessBadge({ row }: { row: ReadinessRow | null }) {
  if (!row) return null;
  return (
    <div className="mt-2 space-y-1 text-xs" data-testid={`readiness-${row.visitId}`}>
      <p className={`font-bold ${row.cleared ? "text-emerald-700" : "text-amber-800"}`}>
        {row.cleared ? `جاهز — أقرّه ${row.cleared.by ?? ""}` : row.attention ? `يحتاج اطلاعًا (${row.attention})` : "لم تُقَرّ الجاهزية"}
      </p>
      {row.checklist?.length ? (
        <ul className="list-inside list-disc text-slate-700">
          {row.checklist.map(item => <li key={item.key} className={item.state === "attention" ? "text-amber-800" : ""}>{item.label}</li>)}
        </ul>
      ) : null}
      {row.balances?.length ? (
        <p className="text-slate-700">المستحق: {row.balances.map(line => <span key={line.currency} className={line.warn ? "font-bold text-red-700" : ""}>{formatMoney(line.dueMinor, line.currency)} </span>)}</p>
      ) : null}
    </div>
  );
}

/** تسجيل الوصول: ملفٌّ من البحث (ضمن نطاقك) أو اسمٌ حر لمريضٍ بلا ملف. */
function ArrivalForm({ onArrived }: { onArrived: () => void }) {
  const uid = useId();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [matches, setMatches] = useState<PatientMatch[]>([]);
  const [picked, setPicked] = useState<PatientMatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const term = name.trim();
    if (picked || term.length < 2) { setMatches([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/patients?q=${encodeURIComponent(term)}`, { cache: "no-store", signal: controller.signal })
        .then(response => response.ok ? response.json() : [])
        .then((rows: PatientMatch[]) => setMatches(Array.isArray(rows) ? rows.slice(0, 5) : []))
        .catch(() => undefined);
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [name, picked]);

  async function arrive() {
    setBusy(true); setMessage(null);
    try {
      const body = picked
        ? { patientId: picked.id, patientName: picked.fullName, patientPhone: picked.phone ?? "", note }
        : { patientName: name, patientPhone: phone, note };
      const response = await fetch("/api/visits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage({ ok: false, text: payload?.message ?? "تعذّر تسجيل المريض." }); return; }
      setMessage({ ok: true, text: `سُجّل وصول ${payload?.patientName ?? "المريض"}.` });
      setName(""); setPhone(""); setNote(""); setPicked(null);
      onArrived();
    } catch { setMessage({ ok: false, text: "تعذّر الاتصال بالخادم. لم يُعتبر الوصول مسجّلًا." }); }
    finally { setBusy(false); }
  }

  return (
    <section aria-labelledby={`${uid}-title`} className="rounded-2xl border border-navy-200 bg-white p-4" data-testid="arrival-form">
      <h2 id={`${uid}-title`} className="mb-2 text-sm font-bold text-navy-900">تسجيل وصول</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        <label htmlFor={`${uid}-name`} className="text-xs font-bold text-navy-900">اسم المريض
          <input id={`${uid}-name`} value={picked ? picked.fullName : name} disabled={busy}
            onChange={event => { setPicked(null); setName(event.target.value); }}
            className="mt-1 block min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
        </label>
        {picked ? null : (
          <label htmlFor={`${uid}-phone`} className="text-xs font-bold text-navy-900">الجوال
            <input id={`${uid}-phone`} dir="ltr" value={phone} disabled={busy} onChange={event => setPhone(event.target.value)}
              className="mt-1 block min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
          </label>
        )}
        <label htmlFor={`${uid}-note`} className="text-xs font-bold text-navy-900">ملاحظة
          <input id={`${uid}-note`} value={note} disabled={busy} onChange={event => setNote(event.target.value)}
            className="mt-1 block min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
        </label>
      </div>
      {matches.length > 0 ? (
        <ul aria-label="ملفات مطابقة" className="mt-2 space-y-1">
          {matches.map(match => (
            <li key={match.id}>
              <button type="button" onClick={() => { setPicked(match); setMatches([]); }}
                className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-start text-sm hover:border-navy-300">
                {match.fullName} <span className="text-xs text-slate-600">({match.patientNumber})</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {picked ? <p className="mt-2 text-xs text-slate-700">مرتبط بملف {picked.patientNumber}. <button type="button" className="font-bold underline" onClick={() => setPicked(null)}>إلغاء الربط</button></p> : null}
      <button type="button" onClick={() => void arrive()} disabled={busy || !(picked || name.trim())}
        className="mt-3 min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">وصل</button>
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p> : null}
    </section>
  );
}
