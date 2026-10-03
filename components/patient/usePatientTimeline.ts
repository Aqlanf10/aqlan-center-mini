"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readPatientTimeline, type PatientTimelinePayload } from "@/lib/patient-timeline-read";

interface TimelineOwner { key: string }
interface TimelineRequest { owner: TimelineOwner; controller: AbortController }

interface TimelineSnapshot {
  key: string;
  payload: PatientTimelinePayload | null;
  error: string | null;
}

/** Fetch lifecycle only. Authority and refresh ownership remain in the patient workspace. */
export function usePatientTimeline({ patientId, authorityKey, refreshKey, readable, open }: {
  patientId: number;
  authorityKey: string;
  refreshKey: number | string;
  readable: boolean;
  open: boolean;
}) {
  const input = JSON.stringify([patientId, authorityKey, refreshKey, readable, open]);
  const [identity, setIdentity] = useState({ input, generation: 0 });
  const [snapshot, setSnapshot] = useState<TimelineSnapshot | null>(null);
  // A changed input gets a fresh render identity, including A -> B -> A before
  // passive cleanup. React retries this render; old snapshots never match it.
  // Request refs remain callback/effect-only, so discarded renders cannot mutate
  // the authority of a committed request.
  const generation = identity.input === input ? identity.generation : identity.generation + 1;
  if (identity.input !== input) { setIdentity({ input, generation }); setSnapshot(null); }
  const key = JSON.stringify([input, generation]);
  const committedOwner = useRef<TimelineOwner | null>(null);
  const request = useRef<TimelineRequest | null>(null);

  // Only committed layouts publish authority to callbacks. An abandoned render
  // never retires the live owner, and unmount retires it before passive cleanup.
  useLayoutEffect(() => {
    const owners = committedOwner; const reads = request;
    const owner: TimelineOwner = { key };
    owners.current = owner;
    return () => {
      if (owners.current === owner) owners.current = null;
      if (reads.current?.owner === owner) {
        reads.current.controller.abort();
        reads.current = null;
      }
    };
  }, [key]);

  const load = useCallback(async () => {
    const owner = committedOwner.current;
    // A retained callback from a previous/unmounted owner may do nothing at all:
    // in particular it cannot clear or abort the current owner's pending read.
    if (!readable || !open || !owner || owner.key !== key) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    const pending: TimelineRequest = { owner, controller };
    request.current = pending;
    const active = () => committedOwner.current === owner && request.current === pending && !controller.signal.aborted;
    try {
      const response = await fetch(`/api/patients/${patientId}/timeline`, { cache: "no-store", signal: controller.signal });
      if (!active()) return;
      // Never wait for a denied/failed body to revoke an older successful read.
      if (!response.ok) {
        setSnapshot({ key, payload: null, error: "الخط الزمني غير متاح ضمن الوصول الحالي. أعد التحقق قبل المتابعة." });
        return;
      }
      const body: unknown = await response.json();
      if (!active()) return;
      const payload = readPatientTimeline(body, patientId);
      setSnapshot({ key, payload, error: payload ? null : "بيانات الخط الزمني غير مكتملة؛ تعذّر تأكيد المصادر المتاحة." });
    } catch {
      if (active()) setSnapshot({ key, payload: null, error: "تعذّر تحميل الخط الزمني. لا تُعرض نسخة سابقة." });
    }
  }, [key, open, patientId, readable, setSnapshot]);

  useEffect(() => {
    const owners = committedOwner; const reads = request;
    const owner = owners.current;
    if (!owner || owner.key !== key) return;
    let retired = false;
    // Start only for this committed lease. A delayed old passive cleanup must
    // neither cancel a newer lease's request nor let an old microtask launch.
    if (open && readable) void Promise.resolve().then(() => {
      if (!retired && owners.current === owner) void load();
    });
    return () => {
      retired = true;
      if (reads.current?.owner === owner) {
        reads.current.controller.abort();
        reads.current = null;
      }
    };
  }, [key, load, open, readable]);

  const reload = useCallback(() => {
    const owner = committedOwner.current;
    if (!readable || !open || !owner || owner.key !== key) return Promise.resolve();
    // Check ownership before clearing; stale callbacks cannot strand a new owner.
    setSnapshot(null);
    return load();
  }, [key, load, open, readable, setSnapshot]);

  const accepted = readable && open && snapshot?.key === key ? snapshot : null;
  return {
    payload: accepted?.payload ?? null,
    error: !readable ? "الخط الزمني غير متاح حتى اكتمال التحقق من الوصول الحالي." : accepted?.error ?? null,
    reload,
  };
}
