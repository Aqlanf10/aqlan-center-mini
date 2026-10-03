"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { decodePatientLabSnapshot, validPatientLabId, type PatientLabSnapshot } from "@/lib/patient-lab-read";

const failedRead = "تعذّر تحميل طلبات المعمل. أعد المحاولة قبل تنفيذ أي إجراء.";
type ReadOwner = {
  scope: string;
  active: boolean;
  sequence: number;
  controller: AbortController | null;
  snapshot: PatientLabSnapshot | null;
  writing: boolean;
  allowDraft: boolean;
};
type ReadState = { owner: ReadOwner; phase: "loading" | "error" | "denied" | "ready"; error: string | null; data: PatientLabSnapshot | null };

/** Local read ownership only; this does not grant permission or replace the
 * server's guards. Each patient/authority incarnation retires its old handlers. */
export function usePatientLabRead(patientId: number, authorityKey: string | null) {
  const scope = JSON.stringify([patientId, authorityKey]);
  const owner = useMemo<ReadOwner>(() => ({ scope, active: false, sequence: 0, controller: null, snapshot: null, writing: false, allowDraft: false }), [scope]);
  const [state, setState] = useState<ReadState | null>(null);

  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
      owner.sequence++;
      owner.snapshot = null;
      owner.allowDraft = false;
      owner.controller?.abort();
    };
  }, [owner]);

  const load = useCallback(async (): Promise<PatientLabSnapshot | null> => {
    if (!owner.active) return null;
    const sequence = ++owner.sequence;
    owner.controller?.abort();
    owner.snapshot = null;
    const current = () => owner.active && sequence === owner.sequence;
    if (!authorityKey || !validPatientLabId(patientId)) {
      owner.allowDraft = false;
      setState({ owner, phase: "denied", data: null, error: "تعذّر التحقق من المريض أو الجلسة." });
      return null;
    }
    const controller = new AbortController();
    owner.controller = controller;
    setState({ owner, phase: "loading", data: null, error: null });
    try {
      const response = await fetch(`/api/lab?patientId=${patientId}`, { cache: "no-store", signal: controller.signal });
      if (!current()) return null;
      if (!response.ok) {
        const message = response.status === 401 ? "انتهت الجلسة. سجّل الدخول من جديد."
          : response.status === 403 ? "لا تسمح الجلسة الحالية بعرض طلبات المعمل."
          : response.status === 404 ? "سجل المعمل المطلوب غير متاح في السياق الحالي." : failedRead;
        const denied = [401, 403, 404].includes(response.status);
        if (denied) owner.allowDraft = false;
        setState({ owner, phase: denied ? "denied" : "error", data: null, error: message });
        return null;
      }
      const data = decodePatientLabSnapshot(await response.json(), patientId);
      if (!current()) return null;
      if (!data) throw new Error("Invalid patient lab response");
      owner.snapshot = data;
      owner.allowDraft = true;
      setState({ owner, phase: "ready", data, error: null });
      return data;
    } catch {
      if (current()) setState({ owner, phase: "error", data: null, error: failedRead });
      return null;
    }
  }, [owner, patientId, authorityKey]);

  useEffect(() => { void load(); }, [load]);
  const visible = state?.owner === owner ? state : null;
  const data = visible?.phase === "ready" ? visible.data : null;
  const isCurrent = () => owner.active;
  const isSnapshot = (snapshot: PatientLabSnapshot | null) => owner.active && snapshot !== null && owner.snapshot === snapshot;
  return {
    scope, owner, load, isCurrent, isSnapshot, data,
    ready: data !== null && isSnapshot(data),
    showDraft: owner.active && owner.allowDraft,
    phase: visible?.phase ?? "loading",
    error: visible?.error ?? null,
    canAct: () => isSnapshot(data),
  };
}
