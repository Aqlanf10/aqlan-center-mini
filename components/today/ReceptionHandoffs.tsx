"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSession } from "@/components/SessionProvider";
import { audioAlerts } from "@/lib/audio-alerts";
import { canReadReceptionHandoff, readReceptionHandoffs, receptionCheckoutHref, type ReceptionHandoffSnapshot } from "@/lib/reception-handoff";

const POLL_MS = 20_000;
const TIMEOUT_MS = 12_000;

export function ReceptionHandoffs({ children }: { children?: ReactNode }) {
  const session = useSession();
  if (!session || !canReadReceptionHandoff(session.role)) return <>{children}</>;
  // Remount on every principal/authority change; an old request cannot populate another login.
  const ownerKey = JSON.stringify([session.username, session.role, session.permissions ?? null]);
  return <ReceptionHandoffRegister key={ownerKey} username={session.username} role={session.role}>{children}</ReceptionHandoffRegister>;
}

function ReceptionHandoffRegister({ username, role, children }: { username: string; role: string; children?: ReactNode }) {
  const [date, setDate] = useState<string | null>(null);
  const [tab, setTab] = useState<"day" | "checkout">("day");
  const [badge, setBadge] = useState<{ count: number; fresh: boolean }>({ count: 0, fresh: false });
  const tabs = ["day", "checkout"] as const;
  return <>
    <div role="tablist" aria-label="تبويبات اليوم" className="mb-4 flex gap-2">
      {tabs.map((value, index) => <button key={value} type="button" role="tab" id={`today-${value}-tab`}
        aria-selected={tab === value} aria-controls={`today-${value}-panel`} tabIndex={tab === value ? 0 : -1}
        onClick={() => setTab(value)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[1] : tabs[1 - index];
          setTab(next); document.getElementById(`today-${next}-tab`)?.focus();
        }} className={`min-h-11 flex-1 rounded-xl border px-3 py-2 text-sm font-bold ${tab === value ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-navy-800"}`}>
        {value === "day" ? "الانتظار والكراسي" : <>التحصيل والخروج <span aria-live="polite">({badge.fresh ? badge.count : "…"})</span><span className="block text-[10px] font-normal">بانتظار المعالجة اليوم وأمس</span></>}
      </button>)}
    </div>
    <div role="tabpanel" id="today-day-panel" aria-labelledby="today-day-tab" hidden={tab !== "day"}>{children}</div>
    <div role="tabpanel" id="today-checkout-panel" aria-labelledby="today-checkout-tab" hidden={tab !== "checkout"}>
      <section className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3" aria-label="الزيارات الموقّعة للاستقبال">
        <h2 className="text-sm font-extrabold text-emerald-950">التحصيل والخروج</h2>
        <HandoffWindow username={username} role={role} date={null} onDate={setDate} visible={date === null} onStatus={setBadge} />
        {date !== null && <HandoffWindow key={date} username={username} role={role} date={date} onDate={setDate} visible />}
      </section>
    </div>
  </>;
}

function HandoffWindow({ username, role, date, onDate, visible, onStatus }: {
  username: string; role: string; date: string | null; onDate: (date: string | null) => void;
  visible: boolean; onStatus?: (status: { count: number; fresh: boolean }) => void;
}) {
  const [snapshot, setSnapshot] = useState<ReceptionHandoffSnapshot | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "stale" | "denied">("loading");
  const [newIds, setNewIds] = useState<Set<number>>(() => new Set());
  const retry = useRef<() => void>(() => {});
  const [history, setHistory] = useState(false);

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
        const discovered = seen === null ? [] : accepted.items.filter(row => row.status === "pending" && !seen!.has(row.visitId));
        if (date === null && discovered.length > 0) {
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

  useEffect(() => {
    onStatus?.({ count: snapshot?.items.filter(row => row.status === "pending").length ?? 0, fresh: state === "ready" });
  }, [onStatus, snapshot, state]);

  const usable = state === "ready";
  const pending = snapshot?.items.filter(row => row.status === "pending") ?? [];
  const handled = snapshot?.items.filter(row => row.status !== "pending") ?? [];
  const rows = history ? handled : pending;
  const labels = { pending: "بانتظار الاستقبال", collected: "حُصّلت فاتورة الزيارة", deferred: "أُجّل الدفع — الرصيد باقٍ", handled: "تمت المعالجة — لا تعني سداد الرصيد" };
  return <div hidden={!visible}>
    <div role="status" aria-live="polite" className="text-xs">
      {state === "loading" ? "جارٍ تحميل الزيارات الموقّعة…" : state === "denied" ? "تعذّر التحقق من صلاحية الوصول. سجّل الدخول بحساب الاستقبال." : state === "stale" ? "تعذّر تحديث التوقيعات. آخر قائمة غير محدثة؛ أعد المحاولة قبل فتح التحصيل." :
        pending.length === 0 ? "لا توجد زيارات بانتظار المعالجة في الفترة المعروضة." : pending.some(row => newIds.has(row.visitId)) ? "توقيع جديد بانتظار الاستقبال" : null}
    </div>
    <div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex flex-wrap items-center gap-2">يومان ينتهيان بتاريخ
          <input aria-label="نهاية فترة التوقيع" type="date" value={date ?? snapshot?.toDate ?? ""}
            onChange={event => onDate(event.target.value || null)} className="min-h-11 max-w-full rounded-xl border border-slate-300 bg-white px-2" />
        </label>
        {date !== null && <button type="button" onClick={() => onDate(null)} className="min-h-11 rounded-xl border px-3">آخر يومين</button>}
        <button type="button" onClick={() => retry.current()} className="min-h-11 rounded-xl border px-3">تحديث التوقيعات</button>
        <button type="button" aria-pressed={history} onClick={() => setHistory(value => !value)} className="min-h-11 rounded-xl border px-3">
          {history ? `بانتظار المعالجة (${pending.length})` : `سجل المعالجة (${handled.length})`}
        </button>
      </div>
      {snapshot && <p className="mt-2 text-xs text-slate-600">تاريخ التوقيع: {snapshot.fromDate} إلى {snapshot.toDate}. فتح الملف وحده لا ينهي المهمة؛ معالجة الزيارة لا تمحو دين المريض. المهام الأقدم تُعرض باختيار تاريخ التوقيع.</p>}
      {rows.length > 0 && <ul aria-label={history ? "سجل معالجة الاستقبال" : "مهام الاستقبال المعلقة"}
        tabIndex={0} className="mt-2 max-h-64 space-y-1 overflow-y-auto overscroll-contain">
        {rows.map(row => <li key={row.visitId} data-handoff-visit={row.visitId} data-handoff-status={row.status}
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-white p-2">
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-bold">{row.patientName} {newIds.has(row.visitId) && row.status === "pending" && <span className="text-xs text-emerald-700">توقيع جديد</span>}</p>
            <p className="text-xs text-slate-600">ملف {row.patientNumber} · زيارة #{row.visitId} · {new Intl.DateTimeFormat("ar-YE", { timeZone: snapshot!.clinicTimeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(row.signedAt))}</p>
            {history && <p className="text-xs text-slate-600">{labels[row.status]}{row.handledReason ? ` · ${row.handledReason}` : ""}</p>}
          </div>
          {usable ? <a href={receptionCheckoutHref(row)} className="inline-flex min-h-11 items-center rounded-xl bg-emerald-800 px-3 text-xs font-bold text-white">فتح تحصيل الزيارة #{row.visitId}</a>
            : <span className="text-xs text-slate-500">الفتح متوقف حتى تحديث القائمة</span>}
        </li>)}
      </ul>}
      {history && usable && handled.length === 0 && <p className="mt-2 text-xs">لا توجد زيارات معالجة في الفترة المعروضة.</p>}
    </div>
  </div>;
}
