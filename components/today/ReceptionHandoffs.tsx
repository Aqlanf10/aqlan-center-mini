"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { audioAlerts } from "@/lib/audio-alerts";
import { canReadReceptionHandoff, readReceptionHandoffs, receptionCheckoutHref, type ReceptionHandoffSnapshot } from "@/lib/reception-handoff";

const POLL_MS = 20_000;
const TIMEOUT_MS = 12_000;

export function ReceptionHandoffs() {
  const session = useSession();
  if (!session || !canReadReceptionHandoff(session.role)) return null;
  // Remount on every principal/authority change; an old request cannot populate another login.
  const ownerKey = JSON.stringify([session.username, session.role, session.permissions ?? null]);
  return <ReceptionHandoffRegister key={ownerKey} username={session.username} role={session.role} />;
}

function ReceptionHandoffRegister({ username, role }: { username: string; role: string }) {
  const [date, setDate] = useState<string | null>(null);
  return (
    <section className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4" aria-label="الزيارات الموقّعة للاستقبال">
      <h2 className="text-sm font-extrabold text-emerald-950">الزيارات الموقّعة للاستقبال</h2>
      <p className="mt-1 text-xs text-slate-600">راجع الحساب عند الفتح؛ التوقيع لا يعني اكتمال التحصيل. قد تبقى مراجعات تحصيل أقدم، ويمكن الرجوع إليها باختيار تاريخ التوقيع.</p>
      <HandoffWindow key={date ?? "latest"} username={username} role={role} date={date} onDate={setDate} />
    </section>
  );
}

function HandoffWindow({ username, role, date, onDate }: {
  username: string; role: string; date: string | null; onDate: (date: string | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<ReceptionHandoffSnapshot | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "stale" | "denied">("loading");
  const [newIds, setNewIds] = useState<Set<number>>(() => new Set());
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    let busy = false;
    let controller: AbortController | null = null;
    let seen: Set<number> | null = null;
    const load = async () => {
      if (!active || busy || document.visibilityState === "hidden") return;
      busy = true;
      controller = new AbortController();
      const current = controller;
      const timeout = setTimeout(() => current.abort(), TIMEOUT_MS);
      try {
        const query = date === null ? "" : `&date=${encodeURIComponent(date)}`;
        const response = await fetch(`/api/visits?view=reception-handoff${query}`, { cache: "no-store", signal: current.signal });
        if (!active) return;
        if (response.status === 401 || response.status === 403) {
          setSnapshot(null); setNewIds(new Set()); setState("denied"); seen = null;
          return;
        }
        if (!response.ok) throw new Error("Unavailable");
        const payload: unknown = await response.json();
        if (!active) return;
        const returnedOwner = payload && typeof payload === "object" && "owner" in payload ? payload.owner : null;
        if (returnedOwner && typeof returnedOwner === "object" && "username" in returnedOwner && "role" in returnedOwner
          && (returnedOwner.username !== username || returnedOwner.role !== role)) {
          setSnapshot(null); setNewIds(new Set()); setState("denied"); seen = null;
          return;
        }
        const accepted = readReceptionHandoffs(payload, { username, role }, date);
        if (!active) return;
        if (!accepted) throw new Error("Invalid reception handoff");
        const discovered = seen === null ? [] : accepted.items.filter(row => !seen!.has(row.visitId));
        if (discovered.length > 0) {
          setNewIds(previous => new Set([...previous, ...discovered.map(row => row.visitId)]));
          audioAlerts.playStatusChange();
        }
        // A visit may temporarily disappear from a response; do not alert twice on reappearance.
        seen = new Set([...(seen ?? []), ...accepted.items.map(row => row.visitId)]);
        setSnapshot(accepted); setState("ready");
      } catch {
        if (active) setState("stale");
      } finally {
        clearTimeout(timeout);
        busy = false;
      }
    };
    retry.current = () => { void load(); };
    const refresh = () => { void load(); };
    void load();
    const interval = setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false; controller?.abort(); retry.current = () => {};
      clearInterval(interval); window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh);
    };
  }, [username, role, date]);

  const usable = state === "ready";
  return <>
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-2">يومان ينتهيان بتاريخ
        <input aria-label="نهاية فترة التوقيع" type="date" value={date ?? snapshot?.toDate ?? ""}
          onChange={event => onDate(event.target.value || null)} className="min-h-11 rounded-xl border border-slate-300 bg-white px-2" />
      </label>
      {date !== null && <button type="button" onClick={() => onDate(null)} className="min-h-11 rounded-xl border px-3">آخر يومين</button>}
      <button type="button" onClick={() => retry.current()} className="min-h-11 rounded-xl border px-3">تحديث التوقيعات</button>
    </div>
    {snapshot && <p className="mt-2 text-xs text-slate-600">تاريخ التوقيع: {snapshot.fromDate} إلى {snapshot.toDate} بتوقيت العيادة. هذه قائمة توقيع وليست قائمة مبالغ غير مسددة.</p>}
    <div role="status" aria-live="polite" className="mt-2 text-sm">
      {state === "loading" ? "جارٍ تحميل الزيارات الموقّعة…" : state === "denied" ? "تعذّر التحقق من صلاحية الوصول. سجّل الدخول بحساب الاستقبال." : state === "stale" ? "تعذّر تحديث التوقيعات. آخر قائمة غير محدثة؛ أعد المحاولة قبل فتح التحصيل." :
        snapshot?.items.length === 0 ? "لا توجد توقيعات في الفترة المعروضة." : `زيارات موقّعة: ${snapshot?.items.length}`}
    </div>
    {snapshot && snapshot.items.length > 0 && <ul className="mt-3 space-y-2">
      {snapshot.items.map(row => <li key={row.visitId} data-handoff-visit={row.visitId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white p-3">
        <div className="min-w-0">
          <p className="font-bold">{row.patientName} {newIds.has(row.visitId) && <span className="text-xs text-emerald-700">توقيع جديد</span>}</p>
          <p className="text-xs text-slate-600">ملف {row.patientNumber} · زيارة #{row.visitId} · {new Intl.DateTimeFormat("ar-YE", { timeZone: snapshot.clinicTimeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(row.signedAt))}</p>
        </div>
        {usable ? <a href={receptionCheckoutHref(row)} className="inline-flex min-h-11 items-center rounded-xl bg-emerald-800 px-3 text-xs font-bold text-white">فتح تحصيل الزيارة #{row.visitId}</a>
          : <span className="text-xs text-slate-500">الفتح متوقف حتى تحديث القائمة</span>}
      </li>)}
    </ul>}
  </>;
}
