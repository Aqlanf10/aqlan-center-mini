"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Armchair, CheckCheck, ClipboardCheck, RefreshCw, UserRound, WalletCards } from "lucide-react";
import { useSession } from "@/components/SessionProvider";
import { audioAlerts } from "@/lib/audio-alerts";
import { canReadReceptionHandoff, receptionCheckoutHref } from "@/lib/reception-handoff";

import { readOperationalCheckoutQueue, checkoutEventKey, discoverCheckoutEvents, type OperationalCheckoutSnapshot } from "@/lib/operational-checkout";
import { ReceptionFinancialVerification } from "./ReceptionFinancialVerification";
import { OperationalCheckoutPanel } from "./OperationalCheckoutPanel";
import styles from "./reception.module.css";

const POLL_MS = 20_000;
const TIMEOUT_MS = 12_000;

function rememberTab(value: "day" | "checkout", visitId: number | null = null) {
  const url = new URL(window.location.href);
  if (value === "checkout") url.searchParams.set("reception", "checkout");
  else url.searchParams.delete("reception");
  if (visitId !== null) url.searchParams.set("receptionVisit", String(visitId));
  else url.searchParams.delete("receptionVisit");
  window.history.replaceState(window.history.state, "", url);
}

export function ReceptionHandoffs({ children, checkoutVisitId, onHandled }: {
  children?: ReactNode; checkoutVisitId?: number | null; onHandled?: (visitId: number) => void;
}) {
  const session = useSession();
  if (!session || !canReadReceptionHandoff(session.role)) return <>{children}</>;
  // Remount on every principal/authority change; an old request cannot populate another login.
  const ownerKey = JSON.stringify([session.username, session.role, session.permissions ?? null]);
  return <ReceptionHandoffRegister key={ownerKey} username={session.username} role={session.role}
    checkoutVisitId={checkoutVisitId} onHandled={onHandled}>{children}</ReceptionHandoffRegister>;
}

function ReceptionHandoffRegister({ username, role, children, checkoutVisitId, onHandled }: {
  username: string; role: string; children?: ReactNode; checkoutVisitId?: number | null; onHandled?: (visitId: number) => void;
}) {
  const [date, setDate] = useState<string | null>(null);
  const [tab, setTab] = useState<"day" | "checkout">("day");
  const [badge, setBadge] = useState<{ count: number; fresh: boolean }>({ count: 0, fresh: false });
  const [requestedVisit, setRequestedVisit] = useState<number | null>(null);
  const [previousCheckoutVisit, setPreviousCheckoutVisit] = useState(checkoutVisitId);
  if (checkoutVisitId !== previousCheckoutVisit) {
    setPreviousCheckoutVisit(checkoutVisitId);
    if (checkoutVisitId) { setDate(null); setRequestedVisit(checkoutVisitId); setTab("checkout"); }
  }
  const chooseTab = useCallback((value: "day" | "checkout", visitId: number | null = null) => {
    setTab(value);
    rememberTab(value, visitId);
  }, []);
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search), raw = params.get("receptionVisit");
      setTab(params.get("reception") === "checkout" ? "checkout" : "day");
      setRequestedVisit(raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null);
    };
    restore(); window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (checkoutVisitId) rememberTab("checkout", checkoutVisitId);
  }, [checkoutVisitId]);
  const completed = (visitId: number) => {
    setRequestedVisit(null); chooseTab("checkout"); onHandled?.(visitId);
  };
  const tabs = ["day", "checkout"] as const;
  return <>
    <div role="tablist" aria-label="تبويبات اليوم" className={styles.tabs}>
      {tabs.map((value, index) => <button key={value} type="button" role="tab" id={`today-${value}-tab`}
        aria-label={value === "day" ? "الانتظار والكراسي" : `التحصيل والخروج (${badge.fresh ? badge.count : "…"})`}
        aria-selected={tab === value} aria-controls={`today-${value}-panel`} tabIndex={tab === value ? 0 : -1}
        onClick={() => chooseTab(value)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[1] : tabs[1 - index];
          chooseTab(next); document.getElementById(`today-${next}-tab`)?.focus();
        }} className={styles.tab}>
        {value === "day" ? <><Armchair size={20} aria-hidden="true" /><span>الانتظار والكراسي<small>الوصول وحركة الجلسات</small></span></>
          : <><WalletCards size={20} aria-hidden="true" /><span>التحصيل والخروج<small>بانتظار المعالجة اليوم وأمس</small></span><span className={styles.count} aria-live="polite">({badge.fresh ? badge.count : "…"})</span></>}
      </button>)}
    </div>
    <div role="tabpanel" id="today-day-panel" aria-labelledby="today-day-tab" hidden={tab !== "day"}>{children}</div>
    <div role="tabpanel" id="today-checkout-panel" aria-labelledby="today-checkout-tab" hidden={tab !== "checkout"}>
      <section className={styles.queue} aria-label="زيارات الخروج للاستقبال">
        <header className={styles.sectionHeading}><div><h2><ClipboardCheck size={20} aria-hidden="true" />التحصيل والخروج</h2>
          <p>راجع الزيارة، اختر هدف التحصيل، ثم أغلق مهمة الخروج بسبب موثّق.</p></div></header>
        <HandoffWindow username={username} role={role} date={null} onDate={setDate} visible={date === null} onStatus={setBadge}
          requestedVisit={requestedVisit} onHandled={completed} />
        {date !== null && <HandoffWindow key={date} username={username} role={role} date={date} onDate={setDate} visible onHandled={completed} />}
      </section>
    </div>
  </>;
}

function HandoffWindow({ username, role, date, onDate, visible, onStatus, requestedVisit, onHandled }: {
  username: string; role: string; date: string | null; onDate: (date: string | null) => void;
  visible: boolean; onStatus?: (status: { count: number; fresh: boolean }) => void;
  requestedVisit?: number | null; onHandled: (visitId: number) => void;
}) {
  const [snapshot, setSnapshot] = useState<OperationalCheckoutSnapshot | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "stale" | "denied">("loading");
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set());
  const retry = useRef<() => void>(() => {});
  const [history, setHistory] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const consumedRequest = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let busy = false;
    let queued = false;
    let controller: AbortController | null = null;
    let seen: Set<string> | null = null;
    const load = async () => {
      if (!active || document.visibilityState === "hidden") return;
      if (busy) { queued = true; return; }
      busy = true;
      controller = new AbortController();
      const current = controller;
      const timeout = setTimeout(() => current.abort(), TIMEOUT_MS);
      try {
        const query = date === null ? "" : `&date=${encodeURIComponent(date)}`;
        const response = await fetch(`/api/visits?view=operational-checkout${query}`, { cache: "no-store", signal: current.signal });
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
        const accepted = readOperationalCheckoutQueue(payload, { username, role }, date);
        if (!active) return;
        if (!accepted) throw new Error("Invalid reception handoff");
        const events = discoverCheckoutEvents(accepted.items, seen, date !== null);
        const discovered = events.discovered;
        if (date === null && discovered.length > 0) {
          setNewIds(previous => new Set([...previous, ...discovered.map(checkoutEventKey)]));
          audioAlerts.playStatusChange();
        }
        // A visit may temporarily disappear from a response; do not alert twice on reappearance.
        seen = events.seen;
        setSnapshot(accepted); setState("ready");
      } catch {
        if (active) setState("stale");
      } finally {
        clearTimeout(timeout);
        busy = false;
        if (active && queued) { queued = false; void load(); }
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
    consumedRequest.current = null;
    if (requestedVisit) retry.current();
  }, [requestedVisit]);
  useEffect(() => {
    if (!requestedVisit || state !== "ready" || consumedRequest.current === requestedVisit) return;
    const row = snapshot?.items.find(item => item.visitId === requestedVisit);
    if (!row) return;
    consumedRequest.current = requestedVisit;
    setHistory(row.status !== "pending"); setReviewOnly(false);
    setExpanded(row.eligibility === "finished_unsigned" || row.financialReviewRequired ? row.visitId : null);
  }, [requestedVisit, snapshot, state]);

  useEffect(() => {
    onStatus?.({ count: snapshot?.items.filter(row => row.status === "pending").length ?? 0, fresh: state === "ready" });
  }, [onStatus, snapshot, state]);

  const usable = state === "ready";
  const pending = snapshot?.items.filter(row => row.status === "pending") ?? [];
  const handled = snapshot?.items.filter(row => row.status !== "pending") ?? [];
  const flagged = snapshot?.items.filter(row => row.financialReviewRequired) ?? [];
  const rows = reviewOnly ? flagged : history ? handled : pending;
  const labels = { pending: "بانتظار الاستقبال", collected: "حُصّلت فاتورة الزيارة", deferred: "أُجّل الدفع — الرصيد باقٍ", handled: "تمت المعالجة — لا تعني سداد الرصيد" };
  const saved = (visitId: number, patientName: string) => {
    setExpanded(null);
    setNotice(`حُفظ قرار الخروج لـ ${patientName} · زيارة #${visitId}. الدين محفوظ في الحساب.`);
    onHandled(visitId); retry.current();
  };
  return <div hidden={!visible} className={styles.queueBody}>
    <div role="status" aria-live="polite" className={styles.status}>
      {state === "loading" ? "جارٍ تحميل زيارات الخروج…" : state === "denied" ? "تعذّر التحقق من صلاحية الوصول. سجّل الدخول بحساب الاستقبال." : state === "stale" ? "تعذّر تحديث زيارات الخروج. آخر قائمة غير محدثة؛ أعد المحاولة قبل فتح التحصيل." :
        notice ?? (pending.some(row => newIds.has(checkoutEventKey(row))) ? "زيارة جديدة بانتظار الاستقبال" : null)}
    </div>
    <div className={styles.toolbar}>
      <button type="button" aria-pressed={!history && !reviewOnly} onClick={() => { setHistory(false); setReviewOnly(false); setExpanded(null); }} className={styles.button}>بانتظار المعالجة ({pending.length})</button>
      <button type="button" aria-pressed={history && !reviewOnly} onClick={() => { setReviewOnly(false); setHistory(true); setExpanded(null); }} className={styles.button}>سجل المعالجة ({handled.length})</button>
      <button type="button" aria-pressed={reviewOnly} onClick={() => { setReviewOnly(value => !value); setExpanded(null); }} className={styles.button}>تحتاج إعادة تحقق مالية ({flagged.length})</button>
    </div>
    <div className={styles.toolbar}>
      <label>يومان ينتهيان بتاريخ
        <input aria-label="نهاية فترة الخروج أو التوقيع" type="date" value={date ?? snapshot?.toDate ?? ""}
          onChange={event => onDate(event.target.value || null)} className="min-h-11 max-w-full rounded-lg border bg-white px-2" />
      </label>
      {date !== null && <button type="button" onClick={() => onDate(null)} className={styles.button}>آخر يومين</button>}
      <button type="button" onClick={() => retry.current()} className={styles.subtle}><RefreshCw size={15} aria-hidden="true" />تحديث زيارات الخروج</button>
    </div>
    {snapshot && <details className={styles.period}><summary>الفترة المعروضة: {snapshot.fromDate} إلى {snapshot.toDate} · {snapshot.items.length} زيارة</summary>
      <p>تاريخ انتهاء الجلوس أو التوقيع بتوقيت {snapshot.clinicTimeZone}. منها {snapshot.items.filter(row => row.eligibility === "signed").length} موقّعة و{snapshot.items.filter(row => row.eligibility === "finished_unsigned").length} بلا توثيق سريري. المهام الأقدم تُعرض باختيار التاريخ. فتح الملف ومعالجة المتابعة لا يمحوان دين المريض.</p>
    </details>}
    {rows.length > 0 && <ul aria-label={reviewOnly ? "متابعات تحتاج إعادة تحقق مالية" : history ? "سجل معالجة الاستقبال" : "مهام الاستقبال المعلقة"}
      tabIndex={0} className={`${styles.list} ${expanded === null ? styles.listBounded : ""}`}>
      {rows.map(row => <li key={row.visitId} data-handoff-visit={row.visitId} data-handoff-status={row.status} data-handoff-eligibility={row.eligibility} className={styles.row}>
        <div className={styles.rowHeading}>
          <div className={styles.identity}>
            <span className={styles.avatar}><UserRound size={21} aria-hidden="true" /></span>
            <div className="min-w-0">
              <p className={styles.name}>{row.patientName} {newIds.has(checkoutEventKey(row)) && <span className={styles.new}>{row.eligibility === "signed" ? "توقيع جديد" : "خروج جديد"}</span>}</p>
              <p className={styles.meta}>{row.patientNumber ? `ملف ${row.patientNumber}` : "ملف المريض غير مرتبط"} · زيارة #{row.visitId} · {new Intl.DateTimeFormat("ar-YE", { timeZone: snapshot!.clinicTimeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(row.eligibleAt))}</p>
              <p className={`${styles.phase} ${row.eligibility === "signed" ? styles.signed : ""}`}>{row.eligibility === "signed" ? "موثّقة سريريًا" : "انتهى الجلوس — التوثيق السريري غير مسجّل"}</p>
              {row.eligibility === "finished_unsigned" && row.dateBasis === "arrival_fallback" && <p className={styles.meta}>لم يُسجّل وقت انتهاء الجلوس؛ تُعرض ضمن تاريخ الحضور.</p>}
              {(history || reviewOnly) && <p className={styles.meta}>{labels[row.status]}{row.handledReason ? ` · ${row.handledReason}` : ""}</p>}
            </div>
          </div>
          <div className={styles.rowActions}>
            {usable && row.eligibility === "signed" && row.financialReviewRequired && (row.status === "handled" || row.status === "deferred") && <button type="button" onClick={() => setExpanded(value => value === row.visitId ? null : row.visitId)} aria-expanded={expanded === row.visitId} className={styles.button}>إعادة التحقق المالي للزيارة #{row.visitId}</button>}
            {usable ? row.eligibility === "signed" ? <a href={receptionCheckoutHref(row)} className={styles.primary}>فتح تحصيل الزيارة #{row.visitId}</a>
              : row.patientId === null ? <a href={`/visits/${row.visitId}`} className={styles.button}>مراجعة الزيارة وربط ملف المريض</a>
                : <button type="button" onClick={() => setExpanded(value => value === row.visitId ? null : row.visitId)} aria-expanded={expanded === row.visitId} className={styles.primary}>متابعة خروج الزيارة #{row.visitId}</button>
              : <span className={styles.meta}>الفتح متوقف حتى تحديث القائمة</span>}
          </div>
        </div>
        {row.financialReviewRequired && <p className={styles.review}>الحالة المالية تحتاج إعادة تحقق؛ القرار السابق محفوظ ولا يثبت السداد الحالي.</p>}
        {row.visitInvoiceSettled && <p className={styles.settled}>فاتورة هذه الزيارة مسدّدة وفق القراءة الحالية؛ هذا لا يعني سداد رصيد الحساب.</p>}
        {usable && row.eligibility === "signed" && row.financialReviewRequired && (row.status === "handled" || row.status === "deferred") && expanded === row.visitId
          && <ReceptionFinancialVerification key={`${row.visitId}:${row.patientId}:${row.signatureVersion}`} row={row} username={username} role={role}
            onChanged={() => retry.current()} onClose={() => setExpanded(null)} onSaved={() => saved(row.visitId, row.patientName)} />}
        {usable && row.eligibility === "finished_unsigned" && row.patientId !== null && expanded === row.visitId
          && <OperationalCheckoutPanel key={`${row.visitId}:${row.patientId}:${row.finishVersion}`} row={row} username={username} role={role}
            onChanged={() => retry.current()} onClose={() => setExpanded(null)} onSaved={() => saved(row.visitId, row.patientName)} />}
      </li>)}
    </ul>}
    {usable && rows.length === 0 && <div className={styles.empty}><CheckCheck size={32} aria-hidden="true" />
      <p>{reviewOnly ? "لا توجد متابعات تحتاج إعادة تحقق مالية في الفترة المعروضة." : history ? "لا توجد زيارات معالجة في الفترة المعروضة." : "لا توجد زيارات بانتظار المعالجة في الفترة المعروضة."}</p>
      <p>إنهاء مهمة الخروج مستقل عن سداد حساب المريض.</p>
    </div>}
  </div>;
}
