"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { useChairCount } from "@/components/SettingsProvider";
import { sendGatedMove, type VisitReadiness } from "@/components/today/useChairReadiness";
import { patientContextAlerts, type ChairStep, type ChairStepKey } from "@/lib/chair-readiness";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import type { WorkspaceSummary } from "./usePatientWorkspace";

type ReadinessVisit = VisitReadiness & { confirmedAlertRevision: number; stepper?: { steps: ChairStep[]; current: ChairStepKey | null } };
type ChairVisit = { id: number; chair: number | null; status: string };
type Snapshot = { scope: string; visit: ReadinessVisit | null; readinessKnown: boolean; chairsKnown: boolean; chairs: ChairVisit[] };
type Message = { tone: "warn" | "error" | "ok"; text: string };
const pendingWrites = new Set<number>(); // A transport cancellation cannot cancel a write already sent.
const writeSettled = new Set<() => void>();
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const nullableText = (value: unknown) => value === null || typeof value === "string";
const stringList = (value: unknown) => value === null || (Array.isArray(value) && value.every((item) => typeof item === "string"));
const statusValid = (value: unknown) => ["waiting", "called", "in_chair", "done"].includes(String(value));

/** Explicit null is a successful no-visit read. Missing/foreign/malformed data is not. */
export function validPatientReadiness(value: unknown, patientId: number): value is VisitReadiness | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const row = value as VisitReadiness;
  return positiveId(row.visitId) && row.patientId === patientId && statusValid(row.status)
    && (row.chair === null || positiveId(row.chair)) && typeof row.arrivedAt === "string"
    && Number.isFinite(Date.parse(row.arrivedAt)) && nullableText(row.seatedAt) && nullableText(row.signedAt)
    && (row.cleared === null || (!!row.cleared && typeof row.cleared.at === "string" && nullableText(row.cleared.by)))
    && (row.checklist === null || (Array.isArray(row.checklist) && row.checklist.every((item) => item && typeof item.label === "string" && ["ok", "attention", "info"].includes(item.state))))
    && (row.attention === null || (Number.isSafeInteger(row.attention) && Number(row.attention) >= 0))
    && stringList(row.alerts) && (row.historyAlerts === undefined || stringList(row.historyAlerts))
    && (row.editableAlert === undefined || nullableText(row.editableAlert))
    && (row.balances === null || Array.isArray(row.balances));
}

export function availablePatientChairs(rows: readonly ChairVisit[], visit: VisitReadiness | null, chairCount: number): number[] {
  const free: number[] = [];
  for (let chair = 1; chair <= chairCount; chair += 1) {
    if (visit?.status === "called" && visit.chair !== chair) continue;
    if (!rows.some((row) => row.id !== visit?.visitId && row.chair === chair && (row.status === "called" || row.status === "in_chair"))) free.push(chair);
  }
  return free;
}

/** NEW RECONSTRUCTION. Reads and commands use the existing protected readiness/visit owners. */
export function usePatientReadiness({ patientId, patientName, patientPhone, fallbackAlert, summary, onChanged, confirmedAlert }: {
  patientId: number; patientName: string; patientPhone: string | null; fallbackAlert: string | null;
  summary: WorkspaceSummary | null; onChanged: () => void; confirmedAlert?: { revision: number; value: string | null };
}) {
  const session = useSession();
  const chairCount = useChairCount();
  const authority = `${session?.username ?? ""}:${session?.role ?? ""}:${JSON.stringify(session?.permissions ?? {})}`;
  const today = summary?.today ?? clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const scope = JSON.stringify([patientId, authority, today, summary ? summary.openVisit ?? null : "unknown", confirmedAlert?.revision ?? 0, fallbackAlert]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const alertContext = `${patientId}:${authority}`;
  const [alertSnapshot, setAlertSnapshot] = useState<{ context: string; sourceAlert: string | null; visit: ReadinessVisit } | null>(null);
  const [chair, setChair] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const lifetime = useRef({ scope, mounted: true });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const actionGeneration = useRef(0);
  const canOperate = session?.role === "admin" || session?.role === "reception" || session?.role === "doctor";
  const current = snapshot?.scope === scope ? snapshot : null;
  const visit = current?.readinessKnown ? current.visit : null;
  const readinessKnown = current?.readinessKnown === true;
  const chairsKnown = current?.chairsKnown === true;
  const freeChairs = current && readinessKnown && chairsKnown ? availablePatientChairs(current.chairs, visit, chairCount) : [];
  const selectedChair: number | null = chair !== null && freeChairs.includes(chair) ? chair : freeChairs.length > 0 ? freeChairs[0] : null;
  const contextAlive = useCallback(() => lifetime.current.mounted && lifetime.current.scope === scope
    && (typeof document === "undefined" || document.visibilityState === "visible"), [scope]);

  const reload = useCallback(async (): Promise<Snapshot | null> => {
    if (!contextAlive() || !positiveId(patientId) || !patientName || !session) return null;
    const requestGeneration = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setSnapshot(null); // No previous clearance or chair availability survives an in-flight read.
    const alive = () => contextAlive() && generation.current === requestGeneration && !abort.signal.aborted;
    const next: Snapshot = { scope, visit: null, readinessKnown: false, chairsKnown: false, chairs: [] };
    const results = await Promise.allSettled([
      fetch(`/api/visits/readiness?patientId=${patientId}`, { cache: "no-store", signal: abort.signal }).then((response) => {
        // A denial revokes cached sensitive warnings before its body (or the other read) settles.
        if (alive() && [401, 403, 404].includes(response.status)) { setAlertSnapshot(null); setSnapshot(null); }
        return response;
      }),
      fetch("/api/visits", { cache: "no-store", signal: abort.signal }),
    ]);
    if (!alive()) return null;
    try {
      const readyResult = results[0];
      if (readyResult.status !== "fulfilled") throw new Error("تعذّر تحديث جاهزية الزيارة؛ الإجراءات متوقفة حتى التحقق.");
      const response = readyResult.value;
      const payload = await response.json().catch(() => null);
      if (!alive()) return null;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) setAlertSnapshot(null);
        throw new Error(payload?.message ?? "جاهزية الزيارة غير متاحة الآن.");
      }
      if (!payload || !Object.prototype.hasOwnProperty.call(payload, "visit") || !validPatientReadiness(payload.visit, patientId)) throw new Error("بيانات الجاهزية غير مكتملة؛ أعد تحديث الملف.");
      next.visit = payload.visit === null ? null : { ...payload.visit, confirmedAlertRevision: confirmedAlert?.revision ?? 0 };
      next.readinessKnown = true;
      setAlertSnapshot(next.visit ? { context: alertContext, sourceAlert: fallbackAlert, visit: next.visit } : null);
      const chairsResult = results[1];
      if (chairsResult.status === "fulfilled" && chairsResult.value.ok) {
        const rows = await chairsResult.value.json().catch(() => null);
        if (!alive()) return null;
        if (Array.isArray(rows) && rows.every((row) => row && positiveId(row.id) && statusValid(row.status) && (row.chair === null || positiveId(row.chair))) && new Set(rows.map((row) => row.id)).size === rows.length) {
          next.chairs = rows; next.chairsKnown = true;
        }
      }
      if (!alive()) return null;
      setSnapshot(next);
      return next;
    } catch (error) {
      if (alive()) { setSnapshot(null); setMessage({ tone: "error", text: error instanceof Error ? error.message : "تعذّر تحديث جاهزية الزيارة." }); }
      return null;
    }
  }, [contextAlive, patientId, patientName, session, scope, confirmedAlert?.revision, alertContext, fallbackAlert]);

  const invalidateRead = useCallback(() => { ++generation.current; controller.current?.abort(); }, []);
  const retireActions = useCallback(() => { ++actionGeneration.current; }, []);
  useLayoutEffect(() => {
    lifetime.current = { scope, mounted: true };
    const refresh = () => { if (contextAlive() && !pendingWrites.has(patientId)) void reload(); };
    const settled = () => {
      // Busy belongs to the outstanding request, not its now-retired visible scope.
      // A remounted owner also observes the latch until that request really settles.
      setBusy(operation.current || pendingWrites.has(patientId));
      refresh();
    };
    setBusy(operation.current || pendingWrites.has(patientId));
    setMessage(null);
    writeSettled.add(settled);
    const visibility = () => {
      if (document.visibilityState === "visible") refresh();
      else { retireActions(); invalidateRead(); setSnapshot(null); }
    };
    refresh();
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(refresh, 30_000);
    return () => { lifetime.current.mounted = false; retireActions(); writeSettled.delete(settled); invalidateRead(); window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visibility); };
  }, [scope, contextAlive, reload, patientId, invalidateRead, retireActions]);

  const canEnterChair = readinessKnown && summary !== null && (visit === null ? summary.openVisit === null
    : visit.signedAt === null && (visit.status === "waiting" || visit.status === "called") && summary.openVisit?.id === visit.visitId);
  const active = readinessKnown && visit !== null && visit.signedAt === null && visit.status !== "done";
  const clear = async () => {
    const expectedVisit = visit?.visitId;
    if (!canOperate || !contextAlive() || !active || !expectedVisit || visit?.checklist === null || operation.current || pendingWrites.has(patientId)) return;
    const ownedGeneration = actionGeneration.current;
    const actionAlive = () => contextAlive() && actionGeneration.current === ownedGeneration;
    operation.current = true; pendingWrites.add(patientId); setBusy(true); setMessage(null);
    try {
      const fresh = await reload();
      if (!actionAlive() || !fresh?.readinessKnown || fresh.visit?.visitId !== expectedVisit || fresh.visit.signedAt !== null || fresh.visit.status === "done" || fresh.visit.checklist === null) return;
      const reviewed = window.confirm(`راجع هذه البنود قبل إقرار الاطلاع:\n${fresh.visit.checklist.map((item) => item.label).join("\n")}\n\nالإقرار يوثّق المراجعة ولا يستبدل القرار السريري. هل تقرّ الاطلاع؟`);
      if (!reviewed || !actionAlive()) return;
      const response = await fetch(`/api/visits/${expectedVisit}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) });
      if (actionAlive() && [401, 403, 404].includes(response.status)) { setAlertSnapshot(null); setSnapshot(null); onChanged(); }
      const payload = await response.json().catch(() => null);
      if (!actionAlive()) return;
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر إقرار الجاهزية.");
      setMessage({ tone: "ok", text: "حُفظ إقرار المراجعة. تُحدّث حالة الزيارة من الخادم." });
      await reload(); if (actionAlive()) onChanged();
    } catch (error) {
      if (actionAlive()) { setSnapshot(null); setMessage({ tone: "error", text: error instanceof Error ? error.message : "تعذّر تأكيد نتيجة الطلب. راجع الزيارة قبل تكراره." }); }
    } finally {
      pendingWrites.delete(patientId); operation.current = false;
      // Retired actions cannot publish their result; current owners read canonical
      // state afresh. Releasing this latch is not a claim that the write rolled back.
      writeSettled.forEach((settled) => settled());
    }
  };
  const enterChair = async () => {
    const expectedVisit = visit?.visitId ?? null; const requestedChair = selectedChair;
    if (!canOperate || !contextAlive() || !canEnterChair || !chairsKnown || requestedChair === null || operation.current || pendingWrites.has(patientId)) return;
    const ownedGeneration = actionGeneration.current;
    const actionAlive = () => contextAlive() && actionGeneration.current === ownedGeneration;
    operation.current = true; pendingWrites.add(patientId); setBusy(true); setMessage(null);
    try {
      const fresh = await reload();
      if (!actionAlive() || !fresh?.readinessKnown || !fresh.chairsKnown) return;
      if ((fresh.visit?.visitId ?? null) !== expectedVisit || (fresh.visit && (fresh.visit.signedAt !== null || !["waiting", "called"].includes(fresh.visit.status))) || !availablePatientChairs(fresh.chairs, fresh.visit, chairCount).includes(requestedChair)) {
        setMessage({ tone: "warn", text: "تغيّرت الزيارة أو حالة الكرسي؛ راجع الحالة الجديدة ثم أعد اختيار الإجراء." }); return;
      }
      let visitId = expectedVisit;
      if (visitId === null) {
        const response = await fetch("/api/visits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId, patientName, patientPhone, note: "دخول مباشر من ملف المريض" }) });
        const payload = await response.json().catch(() => null);
        if (!actionAlive()) return; // The creation may have completed; never continue another owner's operation.
        if (!response.ok) { onChanged(); await reload(); throw new Error(payload?.message ?? "تعذّر تأكيد تسجيل الوصول. راجع زيارة اليوم قبل المحاولة التالية."); }
        if (!positiveId(payload?.id) || payload.patientId !== patientId) throw new Error("نتيجة تسجيل الوصول غير مكتملة؛ راجع زيارة اليوم قبل المتابعة.");
        visitId = payload.id;
        const verified = await reload();
        if (!actionAlive() || !verified?.readinessKnown || !verified.chairsKnown || verified.visit?.visitId !== visitId || verified.visit.signedAt !== null || !["waiting", "called"].includes(verified.visit.status) || !availablePatientChairs(verified.chairs, verified.visit, chairCount).includes(requestedChair)) { if (actionAlive()) onChanged(); return; }
      }
      if (!actionAlive() || visitId === null) return;
      const response = await sendGatedMove(visitId, { action: "seat", chair: requestedChair }, (text) => {
        if (!actionAlive()) return null;
        const reason = window.prompt(`${text}\n\nللدخول كطوارئ اكتب السبب:`, "");
        return actionAlive() ? reason : null;
      });
      if (actionAlive() && [401, 403, 404].includes(response.status)) { setAlertSnapshot(null); setSnapshot(null); onChanged(); }
      const payload = await response.json().catch(() => null);
      if (!actionAlive()) return;
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الإدخال إلى الكرسي.");
      setMessage({ tone: payload?.warning ? "warn" : "ok", text: typeof payload?.warning === "string" ? payload.warning : `حُفظ الإدخال إلى الكرسي ${requestedChair}` });
      await reload(); if (actionAlive()) onChanged();
    } catch (error) {
      if (actionAlive()) { setSnapshot(null); setMessage({ tone: "error", text: error instanceof Error ? error.message : "تعذّر تأكيد نتيجة الطلب. راجع الزيارة قبل تكراره." }); }
    } finally {
      pendingWrites.delete(patientId); operation.current = false;
      // Retired actions cannot publish their result; current owners read canonical
      // state afresh. Releasing this latch is not a claim that the write rolled back.
      writeSettled.forEach((settled) => settled());
    }
  };
  const statusLabels: Record<string, string> = { waiting: "في الانتظار", called: "نُودي للمريض", in_chair: "على الكرسي", done: "انتهى الجلوس؛ راجع التوقيع" };
  const statusLine = !readinessKnown ? "حالة الزيارة قيد التحقق" : !visit ? "لا زيارة اليوم في القراءة الحالية" : visit.signedAt ? "وُقّعت الزيارة"
    : (statusLabels[visit.status] ?? "حالة غير مؤكدة") + (visit.chair ? ` · كرسي ${visit.chair}` : "");
  const cachedAlerts = alertSnapshot?.context === alertContext ? alertSnapshot.sourceAlert === fallbackAlert
    ? alertSnapshot.visit : { ...alertSnapshot.visit, editableAlert: undefined } : null;
  return { visit, alerts: patientContextAlerts(fallbackAlert, visit ?? cachedAlerts, confirmedAlert), readinessKnown, chairsKnown,
    busy, message, active, statusLine, freeChairs, selectedChair, canEnterChair, clear, enterChair, setChair, reload };
}
