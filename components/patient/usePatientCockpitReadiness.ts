"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { sendGatedMove, type VisitReadiness } from "@/components/today/useChairReadiness";
import type { ChairStep, ChairStepKey } from "@/lib/chair-readiness";
import { isCurrency } from "@/lib/money";
import type { WorkflowSummary } from "./SummaryTab";

export interface CockpitVisit extends VisitReadiness {
  stepper?: { steps: ChairStep[]; current: ChairStepKey | null };
}
type ChairVisit = { id: number; patientId: number | null; chair: number | null; status: string };
type ReadState = "loading" | "ready" | "unavailable";
type Snapshot = { scope: string; readiness: ReadState; chairsState: ReadState; visit: CockpitVisit | null; chairs: ChairVisit[]; denied: boolean };
type Message = { tone: "warn" | "error" | "ok"; text: string };
// Browser-local duplicate-click/remount containment only. Server authorization,
// visit uniqueness and chair arbitration remain owned by the existing endpoints.
const pending = new Map<number, symbol>();
const settledListeners = new Set<() => void>();
// The patient page remounts its cockpit while refreshing after an arrival. Carry
// only this brief operational outcome through that refresh, never clinical data.
const arrivalNotices = new Map<string, { value: Message; at: number }>();
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const statusValid = (value: unknown) => typeof value === "string" && ["waiting", "called", "in_chair", "done"].includes(value);
const dateValid = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || dateValid(value);
const stepValid = (value: unknown) => typeof value === "string" && ["arrived", "ready", "in_chair", "signed", "paid"].includes(value);

function validReadiness(value: unknown, patientId: number): value is CockpitVisit | null {
  if (value === null) return true; // Only an explicit, successful null means no visit.
  if (!value || typeof value !== "object") return false;
  const row = value as CockpitVisit;
  return positiveId(row.visitId) && row.patientId === patientId && statusValid(row.status)
    && (row.chair === null || positiveId(row.chair)) && dateValid(row.arrivedAt)
    && nullableDate(row.seatedAt) && nullableDate(row.signedAt)
    && (row.cleared === null || (!!row.cleared && dateValid(row.cleared.at) && (row.cleared.by === null || typeof row.cleared.by === "string")))
    && (row.checklist === null || (Array.isArray(row.checklist) && row.checklist.every((item) => item && typeof item.label === "string" && ["ok", "attention", "info"].includes(item.state))))
    && (row.attention === null || (Number.isSafeInteger(row.attention) && Number(row.attention) >= 0))
    && (row.alerts === null || (Array.isArray(row.alerts) && row.alerts.every((item) => typeof item === "string")))
    && (row.balances === null || (Array.isArray(row.balances) && row.balances.every((item) => item && isCurrency(item.currency) && Number.isSafeInteger(item.dueMinor) && item.dueMinor >= 0 && typeof item.warn === "boolean")))
    && (row.stepper === undefined || (!!row.stepper && (row.stepper.current === null || stepValid(row.stepper.current))
      && Array.isArray(row.stepper.steps) && row.stepper.steps.every((step) => step && stepValid(step.key) && typeof step.label === "string" && typeof step.done === "boolean")));
}

function validChairs(value: unknown): value is ChairVisit[] {
  return Array.isArray(value) && value.every((row) => row && positiveId(row.id) && statusValid(row.status)
    && (row.patientId === null || positiveId(row.patientId)) && (row.chair === null || positiveId(row.chair)))
    && new Set(value.map((row) => row.id)).size === value.length;
}

function availableChairs(rows: readonly ChairVisit[], visit: CockpitVisit | null, count: number): number[] {
  const free: number[] = [];
  for (let chair = 1; chair <= count; chair += 1) {
    if (visit?.status === "called" && visit.chair !== chair) continue;
    if (!rows.some((row) => row.id !== visit?.visitId && row.chair === chair && ["called", "in_chair"].includes(row.status))) free.push(chair);
  }
  return free;
}

function coherentVisit(snapshot: Snapshot, patientId: number): boolean {
  if (snapshot.readiness !== "ready" || snapshot.chairsState !== "ready") return false;
  const activeRows = snapshot.chairs.filter((row) => row.patientId === patientId && row.status !== "done");
  if (snapshot.visit === null) return activeRows.length === 0;
  const same = snapshot.chairs.find((row) => row.id === snapshot.visit?.visitId);
  return !!same && same.patientId === patientId && same.status === snapshot.visit.status && same.chair === snapshot.visit.chair
    && activeRows.every((row) => row.id === snapshot.visit?.visitId);
}

/** Read/command ownership for the existing cockpit, not a second visit engine. */
export function usePatientCockpitReadiness({ patientId, patientName, patientPhone, fallbackAlert, summary, chairCount, onChanged }: {
  patientId: number; patientName: string; patientPhone: string | null; fallbackAlert: string | null;
  summary: WorkflowSummary | null; chairCount: number; onChanged: () => void;
}) {
  const session = useSession();
  const authority = JSON.stringify([session?.username, session?.role, session?.permissions ?? null]);
  const scope = JSON.stringify([patientId, authority, summary ? summary.openVisit : "unknown", fallbackAlert, chairCount]);
  const alertScope = JSON.stringify([patientId, authority]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [cachedAlerts, setCachedAlerts] = useState<{ scope: string; alerts: string[] } | null>(null);
  const [deniedScopes, setDeniedScopes] = useState<ReadonlySet<string>>(() => new Set());
  const [chairChoice, setChairChoice] = useState<{ scope: string; chair: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ scope: string; value: Message } | null>(null);
  const lifetime = useRef({ scope, mounted: false });
  const generation = useRef(0);
  const actionGeneration = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const canOperate = !!session && ["admin", "reception", "doctor"].includes(session.role);
  const canRead = !!session && ["admin", "reception", "doctor", "assistant"].includes(session.role);
  // Re-entering an earlier principal after A→B→A must obtain a new grant too.
  // Changing summary/alert text alone does not discard clinical warning history.
  useLayoutEffect(() => () => { setCachedAlerts(null); }, [alertScope]);
  const alive = useCallback(() => lifetime.current.mounted && lifetime.current.scope === scope
    && (typeof document === "undefined" || document.visibilityState === "visible"), [scope]);
  const retire = useCallback(() => {
    ++actionGeneration.current; ++generation.current; controller.current?.abort();
  }, []);
  const showMessage = (value: Message) => { if (alive()) setMessage({ scope, value }); };

  const reload = useCallback(async (): Promise<Snapshot | null> => {
    if (!alive() || !canRead || !positiveId(patientId)) return null;
    const ticket = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const current = () => alive() && generation.current === ticket && !abort.signal.aborted;
    const next: Snapshot = { scope, readiness: "loading", chairsState: "loading", visit: null, chairs: [], denied: false };
    const publish = () => { if (current()) setSnapshot({ ...next }); };
    const deny = () => {
      next.denied = true; next.visit = null; next.readiness = "unavailable";
      setCachedAlerts(null); setDeniedScopes((previous) => new Set([...previous, alertScope]));
    };
    publish();
    // Each peer publishes its own failure immediately, even if the other hangs.
    const readVisit = async () => {
      try {
        const response = await fetch(`/api/visits/readiness?patientId=${patientId}`, { cache: "no-store", signal: abort.signal });
        if (!current()) return;
        if (!response.ok) {
          next.readiness = "unavailable";
          if ([401, 403, 404].includes(response.status)) deny();
          publish(); return;
        }
        const payload = await response.json();
        if (!current()) return;
        if (next.denied) { publish(); return; }
        if (!payload || !Object.hasOwn(payload, "visit") || !validReadiness(payload.visit, patientId)) throw new Error("readiness");
        next.visit = payload.visit; next.readiness = "ready";
        setCachedAlerts({ scope: alertScope, alerts: payload.visit?.alerts ?? [] });
      } catch {
        if (!current()) return;
        next.readiness = "unavailable";
      }
      publish();
    };
    const readChairs = async () => {
      try {
        const response = await fetch("/api/visits", { cache: "no-store", signal: abort.signal });
        if (!current()) return;
        if (!response.ok) {
          next.chairsState = "unavailable";
          if ([401, 403, 404].includes(response.status)) deny();
          publish(); return;
        }
        const payload = await response.json();
        if (!current()) return;
        if (!validChairs(payload)) throw new Error("chairs");
        next.chairs = payload; next.chairsState = "ready";
      } catch {
        if (!current()) return;
        next.chairsState = "unavailable";
      }
      publish();
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([readVisit(), readChairs()]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            if (current()) {
              if (next.readiness === "loading") next.readiness = "unavailable";
              if (next.chairsState === "loading") next.chairsState = "unavailable";
              publish(); abort.abort();
            }
            resolve();
          }, 15_000);
        }),
      ]);
      if (!current()) return null;
      // A late successful peer cannot undo a denial in this same generation.
      if (next.readiness === "ready" && !next.denied) {
        setDeniedScopes((previous) => { const nextScopes = new Set(previous); nextScopes.delete(alertScope); return nextScopes; });
      }
      return next;
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }, [alive, canRead, patientId, scope, alertScope]);

  useLayoutEffect(() => {
    lifetime.current = { scope, mounted: true };
    const refresh = () => { if (!pending.has(patientId)) void reload(); };
    const settled = () => { setBusy(pending.has(patientId)); refresh(); };
    settledListeners.add(settled);
    const visibility = () => {
      if (document.visibilityState === "visible") refresh();
      else { retire(); setSnapshot(null); }
    };
    const first = window.setTimeout(() => {
      const notice = arrivalNotices.get(alertScope);
      if (notice) {
        arrivalNotices.delete(alertScope);
        if (Date.now() - notice.at < 60_000) setMessage({ scope, value: notice.value });
      }
      settled();
    }, 0);
    const poll = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visibility);
    return () => {
      lifetime.current.mounted = false; retire();
      // Scope equality alone cannot distinguish rapid A→B→A commits before B's
      // scheduled read. Retire accepted views as well as in-flight generations.
      setSnapshot(null); setMessage(null);
      settledListeners.delete(settled); window.clearTimeout(first); window.clearInterval(poll);
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visibility);
    };
  }, [scope, alertScope, patientId, reload, retire]);

  const current = snapshot?.scope === scope ? snapshot : null;
  const readiness = canRead ? current?.readiness ?? "loading" : "unavailable";
  const chairsState = canRead ? current?.chairsState ?? "loading" : "unavailable";
  const visit = readiness === "ready" ? current?.visit ?? null : null;
  const coherent = current !== null && coherentVisit(current, patientId);
  const freeChairs = coherent && current ? availableChairs(current.chairs, visit, chairCount) : [];
  const selectedChair = chairChoice?.scope === scope && freeChairs.includes(chairChoice.chair) ? chairChoice.chair : freeChairs[0] ?? null;
  // Workflow's openVisit can be from an earlier day or a stale parent read. It
  // invalidates this hook's scope but cannot overrule the two current endpoints.
  const canEnterChair = canOperate && coherent && (visit === null
    || (visit.signedAt === null && ["waiting", "called"].includes(visit.status)));
  const active = readiness === "ready" && visit !== null && visit.signedAt === null && visit.status !== "done";
  const denied = deniedScopes.has(alertScope) || current?.denied === true;
  const alertLabels = denied || !canRead ? [] : visit?.alerts ?? (cachedAlerts?.scope === alertScope ? cachedAlerts.alerts : []);
  const alerts = denied || !canRead ? [] : [...new Set([
    ...(cachedAlerts?.scope === alertScope && fallbackAlert ? [fallbackAlert] : []), ...alertLabels,
  ])];

  const run = async (kind: "clear" | "seat") => {
    const expectedVisit = visit?.visitId ?? null; const requestedChair = selectedChair;
    if (!canOperate || !alive() || pending.has(patientId)
      || (kind === "clear" ? !active || !visit || visit.checklist === null : !canEnterChair || requestedChair === null)) return;
    const operation = Symbol(); pending.set(patientId, operation); setBusy(true); setMessage(null);
    const ownedGeneration = actionGeneration.current;
    const actionAlive = () => alive() && actionGeneration.current === ownedGeneration;
    const rejectDenied = (response: Response) => {
      if (![401, 403, 404].includes(response.status)) return;
      setSnapshot(null); setCachedAlerts(null);
      setDeniedScopes((previous) => new Set([...previous, alertScope]));
      throw new Error("تعذّر التحقق من صلاحية الإجراء؛ أعد التحقق من الزيارة.");
    };
    try {
      const fresh = await reload();
      if (!actionAlive() || fresh?.readiness !== "ready") return;
      if ((fresh.visit?.visitId ?? null) !== expectedVisit || (fresh.visit && (fresh.visit.signedAt !== null || fresh.visit.status === "done"))) {
        showMessage({ tone: "warn", text: "تغيّرت الزيارة؛ راجع الحالة الجديدة قبل إعادة الإجراء." }); return;
      }
      if (kind === "clear") {
        if (!fresh.visit || fresh.visit.checklist === null) return;
        const response = await fetch(`/api/visits/${fresh.visit.visitId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) });
        if (!actionAlive()) return;
        rejectDenied(response);
        const payload = await response.json().catch(() => null);
        if (!actionAlive()) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر إقرار الجاهزية.");
        showMessage({ tone: "ok", text: "حُفظ إقرار المراجعة؛ تُحدّث الحالة من الخادم." });
      } else {
        if (!coherentVisit(fresh, patientId) || requestedChair === null || (fresh.visit && !["waiting", "called"].includes(fresh.visit.status))
          || !availableChairs(fresh.chairs, fresh.visit, chairCount).includes(requestedChair)) {
          showMessage({ tone: "warn", text: "تغيّرت الزيارة أو حالة الكرسي؛ راجع الحالة الجديدة قبل إعادة الإجراء." }); return;
        }
        let visitId = expectedVisit;
        if (visitId === null) {
          const response = await fetch("/api/visits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId, patientName, patientPhone, note: "دخول مباشر من ملف المريض" }) });
          if (!actionAlive()) return;
          rejectDenied(response);
          const payload = await response.json().catch(() => null);
          if (!actionAlive()) return; // A sent write is not rolled back by retiring its UI owner.
          if (!response.ok) throw new Error(payload?.message ?? "لم يتأكد تسجيل الوصول؛ راجع زيارة اليوم قبل المحاولة التالية.");
          if (!positiveId(payload?.id) || payload.patientId !== patientId) throw new Error("نتيجة تسجيل الوصول غير مكتملة؛ راجع زيارة اليوم.");
          visitId = payload.id;
          const verified = await reload();
          if (!actionAlive()) return;
          if (!verified || !coherentVisit(verified, patientId) || verified.visit?.visitId !== visitId
            || verified.visit.signedAt !== null || !["waiting", "called"].includes(verified.visit.status)
            || !availableChairs(verified.chairs, verified.visit, chairCount).includes(requestedChair)) {
            const value: Message = { tone: "warn", text: "سُجّل الوصول، لكن إدخال الكرسي لم يتأكد؛ راجع زيارة اليوم قبل المتابعة." };
            arrivalNotices.set(alertScope, { value, at: Date.now() }); showMessage(value);
            onChanged(); return;
          }
        }
        if (!actionAlive() || visitId === null) return;
        const response = await sendGatedMove(visitId, { action: "seat", chair: requestedChair }, (text) => {
          if (!actionAlive()) return null;
          const reason = window.prompt(`${text}\n\nللدخول كطوارئ اكتب السبب:`, "");
          return actionAlive() ? reason : null;
        });
        if (!actionAlive()) return;
        rejectDenied(response);
        const payload = await response.json().catch(() => null);
        if (!actionAlive()) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر الإدخال إلى الكرسي.");
        showMessage(typeof payload?.warning === "string" ? { tone: "warn", text: payload.warning } : { tone: "ok", text: `على الكرسي ${requestedChair}` });
      }
      if (actionAlive()) onChanged();
    } catch (error) {
      if (actionAlive()) {
        setSnapshot(null);
        showMessage({ tone: "error", text: error instanceof Error ? error.message : "لم تتأكد نتيجة الطلب؛ راجع الزيارة قبل تكراره." });
        onChanged();
      }
    } finally {
      if (pending.get(patientId) === operation) pending.delete(patientId);
      // Release only this local latch; current owners re-read instead of receiving
      // success from a retired patient's/session's operation.
      settledListeners.forEach((settled) => settled());
    }
  };
  return { visit, alerts, readiness, chairsState, coherent, canOperate, active, freeChairs, selectedChair, busy: busy || pending.has(patientId),
    message: message?.scope === scope ? message.value : null,
    canEnterChair, setChair: (chair: number) => setChairChoice({ scope, chair }), reload,
    clear: () => run("clear"), enterChair: () => run("seat") };
}
