"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/components/SessionProvider";
import type { BalanceLine, ReadinessItem } from "@/lib/chair-readiness";
import { isCurrency } from "@/lib/money";

/** صفّ جاهزية زيارةٍ كما يعيده `GET /api/visits/readiness`. */
export interface VisitReadiness {
  visitId: number;
  patientId: number | null;
  status: string;
  chair: number | null;
  arrivedAt: string;
  seatedAt: string | null;
  signedAt: string | null;
  cleared: { at: string; by: string | null } | null;
  /** null = الملف ليس لهذا الطبيب — تُعرض الشارة بلا تفاصيل. */
  checklist: ReadinessItem[] | null;
  attention: number | null;
  alerts: string[] | null;
  /** Same authorization as alerts; optional while an older server is serving. */
  historyAlerts?: string[] | null;
  editableAlert?: string | null;
  /** null = لا يرى المال (الطبيب بلا «مدفوعات مرضاي»). */
  balances: BalanceLine[] | null;
}

export type TodayReadState = "loading" | "ready" | "unavailable";
type BoardVisit = { id: number; patientId: number | null };
type ReadOwner = { scope: string; foregroundEpoch: number; refreshMs: number };
type Snapshot = {
  owner: ReadOwner; state: TodayReadState; byVisit: Map<number, VisitReadiness>;
  requireClearance: boolean | null;
};
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const dateValid = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || dateValid(value);
const nullableStrings = (value: unknown) =>
  value === null || (Array.isArray(value) && value.every((item) => typeof item === "string"));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validReadiness(value: unknown): value is VisitReadiness {
  if (!record(value)) return false;
  const row = value;
  return positiveId(row.visitId) && (row.patientId === null || positiveId(row.patientId))
    && typeof row.status === "string" && ["waiting", "called", "in_chair", "done"].includes(row.status)
    && (row.chair === null || positiveId(row.chair)) && dateValid(row.arrivedAt)
    && nullableDate(row.seatedAt) && nullableDate(row.signedAt)
    && (row.cleared === null || (record(row.cleared) && dateValid(row.cleared.at)
      && (row.cleared.by === null || typeof row.cleared.by === "string")))
    && (row.checklist === null || (Array.isArray(row.checklist) && row.checklist.every((item) => record(item)
      && typeof item.key === "string" && ["file", "medical_history", "alerts", "flags", "intake"].includes(item.key)
      && typeof item.state === "string" && ["ok", "attention", "info"].includes(item.state) && typeof item.label === "string")))
    && (row.attention === null || (typeof row.attention === "number" && Number.isSafeInteger(row.attention) && row.attention >= 0))
    && nullableStrings(row.alerts)
    && (row.historyAlerts === undefined || nullableStrings(row.historyAlerts))
    && (row.editableAlert === undefined || row.editableAlert === null || typeof row.editableAlert === "string")
    && (row.balances === null || (Array.isArray(row.balances) && row.balances.every((item) => record(item)
      && isCurrency(item.currency) && typeof item.dueMinor === "number" && Number.isSafeInteger(item.dueMinor)
      && item.dueMinor >= 0 && typeof item.warn === "boolean")))
    // A deliberately redacted row never grants previously cached details.
    && (row.checklist !== null || (row.attention === null && row.alerts === null && row.balances === null
      && (row.historyAlerts === undefined || row.historyAlerts === null)
      && (row.editableAlert === undefined || row.editableAlert === null)));
}

/**
 * Independent clinical read for Today. A failed refresh may retain explicitly
 * labelled, same-owner warnings, never current clearance, balances or a grant.
 * The server's movement/override policy remains independent of this read.
 */
export function useChairReadiness(refreshMs: number, session: SessionInfo | null, visits: readonly BoardVisit[]) {
  const authority = JSON.stringify([session?.username, session?.role, session?.permissions ?? null]);
  // A relink, departure or A→B→A board transition must obtain a fresh grant.
  // Sorting prevents an unrelated display-order change from retiring the read.
  const identities = visits.map((visit) => [visit.id, visit.patientId]).sort((a, b) => Number(a[0]) - Number(b[0]));
  const scope = JSON.stringify([authority, identities]);
  const [foregroundEpoch, setForegroundEpoch] = useState(0);
  // Scope text may recur after A→B→A. A retained callback belongs to its exact
  // committed owner, never a later lifetime with equivalent identifiers.
  const owner = useMemo<ReadOwner>(() => ({ scope, foregroundEpoch, refreshMs }), [scope, foregroundEpoch, refreshMs]);
  const canRead = !!session && ["admin", "reception", "doctor", "assistant"].includes(session.role);
  const canClear = !!session && ["admin", "reception", "doctor"].includes(session.role);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const lifetime = useRef({ owner, mounted: false });
  const generation = useRef(0);
  const pending = useRef<{ abort: AbortController; finish: () => void } | null>(null);
  const alive = useCallback(() => lifetime.current.mounted && lifetime.current.owner === owner
    && (typeof document === "undefined" || document.visibilityState === "visible"), [owner]);
  const retire = useCallback(() => {
    ++generation.current;
    pending.current?.abort.abort();
    pending.current?.finish();
    pending.current = null;
  }, []);

  const reload = useCallback(async () => {
    if (!alive() || !canRead) return;
    retire();
    const ticket = generation.current;
    const abort = new AbortController();
    const current = () => alive() && generation.current === ticket && !abort.signal.aborted;
    const publishState = (state: TodayReadState, denied = false) => {
      if (!current()) return;
      setSnapshot((previous) => ({
        owner, state, requireClearance: null,
        byVisit: !denied && previous?.owner === owner ? previous.byVisit : new Map(),
      }));
    };
    publishState("loading");
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    pending.current = { abort, finish };
    const timeout = setTimeout(() => {
      publishState("unavailable"); abort.abort(); finish();
    }, 15_000);
    const read = async () => {
      try {
        const response = await fetch("/api/visits/readiness", { cache: "no-store", signal: abort.signal });
        if (!current()) return;
        // Do not wait for an error body before retiring confidential data.
        if (!response.ok) {
          publishState("unavailable", [401, 403, 404].includes(response.status));
          return;
        }
        const payload: unknown = await response.json();
        if (!current()) return;
        if (!record(payload) || typeof payload.requireClearance !== "boolean"
          || !Array.isArray(payload.items) || !payload.items.every(validReadiness)
          || new Set(payload.items.map((item) => item.visitId)).size !== payload.items.length) {
          publishState("unavailable"); return;
        }
        setSnapshot({ owner, state: "ready", requireClearance: payload.requireClearance,
          byVisit: new Map(payload.items.map((item) => [item.visitId, item])) });
      } catch { publishState("unavailable"); }
    };
    try { await Promise.race([read(), finished]); }
    finally {
      clearTimeout(timeout);
      if (pending.current?.abort === abort) pending.current = null;
    }
  }, [alive, canRead, retire, owner]);

  useLayoutEffect(() => {
    lifetime.current = { owner, mounted: document.visibilityState === "visible" };
    const first = setTimeout(() => { void reload(); }, 0);
    const poll = setInterval(() => { void reload(); }, refreshMs);
    const refresh = () => { void reload(); };
    const visibility = () => {
      if (document.visibilityState === "visible") {
        // A fresh owner is installed by the next committed effect. The old
        // hidden owner's retry/focus closures remain retired in the meantime.
        setForegroundEpoch((epoch) => epoch + 1);
      } else {
        lifetime.current.mounted = false; retire(); setSnapshot(null);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      lifetime.current.mounted = false; retire(); setSnapshot(null);
      clearTimeout(first); clearInterval(poll);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [owner, reload, refreshMs, retire]);

  const current = canRead && snapshot?.owner === owner ? snapshot : null;
  const state: TodayReadState = canRead ? current?.state ?? "loading" : "unavailable";
  return {
    byVisit: current?.byVisit ?? new Map<number, VisitReadiness>(),
    requireClearance: current?.requireClearance ?? null,
    state,
    canClear, reload,
  };
}

/**
 * (CHAIR-1 Slice 3) نداءٌ/إدخالٌ عبر بوابة الجاهزية.
 *
 * الإعداد مغلق (الافتراضي) ⇒ الطلب الأول يمرّ دائمًا ويعود بتحذيرٍ نصّي إن لزم — صفر نقرات.
 * الإعداد مفعَّل والمريض غير مُقَرّ ⇒ 409 برمز البوابة، فيُسأل عن سبب الطوارئ: كتابته تعيد الطلب
 * بسببٍ يُدقَّق، وإلغاؤه يعيد الرفض نفسه (فيُقرّ الجاهزية أولًا).
 */
export async function sendGatedMove(
  visitId: number,
  body: { action: "call" | "seat"; chair: number },
  askEmergencyReason: (message: string) => string | null = (message) =>
    window.prompt(`${message}\n\nللدخول كطوارئ اكتب السبب:`, ""),
): Promise<Response> {
  const send = (extra: Record<string, unknown> = {}) => fetch(`/api/visits/${visitId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...extra }),
  });
  const first = await send();
  if (first.status !== 409) return first;
  const payload = await first.clone().json().catch(() => null) as { code?: string; message?: string } | null;
  if (payload?.code !== "clearance_required" && payload?.code !== "emergency_reason_required") return first;
  const reason = askEmergencyReason(payload.message ?? "");
  if (!reason || !reason.trim()) return first;
  return send({ emergency: true, emergencyReason: reason.trim() });
}
