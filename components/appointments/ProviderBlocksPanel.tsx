"use client";

import { useEffect, useId, useState } from "react";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/**
 * حجب أوقات الأطباء لليوم المعروض (M2 slice 25).
 *
 * GET /api/provider-blocks?date= يعيد أطباء نطاق مواعيدك وحجوباتهم لذلك اليوم؛ والإضافة والإلغاء
 * تحت appointments.schedule.manage (الطبيب بنطاق «مواعيدي» يحجب أوقاته هو فقط). الإضافة تمرّ بقفل
 * يوم الحجز نفسه وتنبّه بعدد المواعيد المحجوزة المتداخلة (لا تُنقل تلقائيًا). الأوقات بتوقيت العيادة.
 */
interface Block { id: string; providerId: number; startsAt: string; endsAt: string; reason: string }
interface Panel { doctors: { id: number; name: string }[]; blocks: Block[]; canManage: boolean }

const ZONE = CLINIC_ZONE_FALLBACK;
function zoneOffsetMs(instant: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant;
}
/** A clinic wall time as an instant (two passes settle a zone transition). */
export function clinicWallTimeToIso(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let instant = wall - zoneOffsetMs(wall);
  instant = wall - zoneOffsetMs(instant);
  return new Date(instant).toISOString();
}
const clock = (iso: string) => new Intl.DateTimeFormat("ar-YE-u-nu-latn", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date(iso));

export function ProviderBlocksPanel({ date, onChanged }: { date: string; onChanged?: () => void }) {
  const uid = useId();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [doctor, setDoctor] = useState("");
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("12:00");
  const [endDate, setEndDate] = useState(date);
  const [reason, setReason] = useState("");
  useEffect(() => { setEndDate(date); }, [date]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/provider-blocks?date=${encodeURIComponent(date)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) { setPanel(null); setError(payload?.message ?? "تعذّر تحميل الحجب."); return; }
        setPanel(payload as Panel); setError(null);
        setDoctor(current => current || String((payload as Panel).doctors[0]?.id ?? ""));
      } catch { if (!cancelled) setError("تعذّر الاتصال بالخادم."); }
    })();
    return () => { cancelled = true; };
  }, [date, version]);

  async function create() {
    if (busy || !doctor || !reason.trim()) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/provider-blocks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: Number(doctor), startsAt: clinicWallTimeToIso(date, from), endsAt: clinicWallTimeToIso(endDate, to), reason: reason.trim() }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage({ ok: false, text: payload?.message ?? "تعذّر حفظ الحجب." }); return; }
      const overlap = Number(payload?.overlappingAppointments ?? 0);
      setMessage({ ok: true, text: overlap > 0 ? `حُفظ الحجب. انتبه: ${overlap} موعدًا محجوزًا لهذا الطبيب داخل وقت الحجب — راجعها وانقلها.` : "حُفظ الحجب." });
      setReason(""); setVersion(current => current + 1); onChanged?.();
    } catch { setMessage({ ok: false, text: "تعذّر التحقق من الحفظ. حدّث القائمة قبل إعادة المحاولة." }); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/provider-blocks/${encodeURIComponent(id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null);
      setMessage(response.ok ? { ok: true, text: "أُلغي الحجب." } : { ok: false, text: payload?.message ?? "تعذّر إلغاء الحجب." });
      setVersion(current => current + 1); onChanged?.();
    } catch { setMessage({ ok: false, text: "تعذّر التحقق من الإلغاء. حدّث القائمة." }); }
    finally { setBusy(false); }
  }

  const name = (id: number) => panel?.doctors.find(doctor => doctor.id === id)?.name ?? `طبيب #${id}`;
  return (
    <details className="rounded-2xl border border-slate-200 bg-white p-3" data-testid="provider-blocks-panel">
      <summary className="cursor-pointer text-sm font-black text-navy-900">حجب أوقات الأطباء {panel ? `(${panel.blocks.length})` : ""}</summary>
      <div className="mt-2 space-y-2 text-sm">
        {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
        {panel && panel.blocks.length === 0 ? <p className="text-xs text-slate-600">لا حجب في هذا اليوم ضمن نطاقك.</p> : null}
        {panel?.blocks.length ? (
          <ul className="space-y-1" data-testid="provider-blocks-list">
            {panel.blocks.map(block => (
              <li key={block.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2" data-block={block.id}>
                <span>
                  <span className="font-bold text-navy-900">{name(block.providerId)}</span>
                  <span dir="ltr" className="mx-2 text-xs text-slate-700">{dayOf(block.startsAt) === dayOf(block.endsAt) ? `${clock(block.startsAt)}–${clock(block.endsAt)}` : `${dayOf(block.startsAt)} ${clock(block.startsAt)} → ${dayOf(block.endsAt)} ${clock(block.endsAt)}`}</span>
                  <span className="text-xs text-slate-700">{block.reason}</span>
                </span>
                {panel.canManage ? (
                  <button type="button" onClick={() => void cancel(block.id)} disabled={busy}
                    className="min-h-9 rounded-lg border border-slate-300 px-2 text-xs font-bold text-navy-900 disabled:opacity-50">إلغاء الحجب</button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {panel?.canManage && panel.doctors.length ? (
          <div className="grid gap-2 rounded-xl border border-slate-200 p-2 sm:grid-cols-2" data-testid="provider-block-form">
            <label className="text-xs font-bold text-navy-900">الطبيب
              <select value={doctor} onChange={event => setDoctor(event.target.value)} disabled={busy} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-2 text-sm">
                {panel.doctors.map(option => <option key={option.id} value={String(option.id)}>{option.name}</option>)}
              </select>
            </label>
            <label htmlFor={`${uid}-reason`} className="text-xs font-bold text-navy-900">السبب (إلزامي)
              <input id={`${uid}-reason`} value={reason} maxLength={300} onChange={event => setReason(event.target.value)} disabled={busy} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
            </label>
            <label className="text-xs font-bold text-navy-900">من الساعة
              <input type="time" value={from} onChange={event => setFrom(event.target.value)} disabled={busy} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-bold text-navy-900">حتى تاريخ
                <input type="date" value={endDate} min={date} onChange={event => { if (event.target.value) setEndDate(event.target.value); }} disabled={busy} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
              </label>
              <label className="text-xs font-bold text-navy-900">الساعة
                <input type="time" value={to} onChange={event => setTo(event.target.value)} disabled={busy} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
              </label>
            </div>
            <button type="button" onClick={() => void create()} disabled={busy || !reason.trim() || !doctor}
              className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50 sm:col-span-2">حجب الوقت</button>
          </div>
        ) : null}
        {message ? <p role={message.ok ? "status" : "alert"} className={`rounded-xl p-2 text-sm ${message.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"}`}>{message.text}</p> : null}
      </div>
    </details>
  );
}
