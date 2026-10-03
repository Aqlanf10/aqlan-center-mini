"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readPeriodontalContext, type PeriodontalContext } from "@/lib/patient-periodontal-context";

interface Snapshot { key: string; status: "loading" | "error" | "ready"; value: PeriodontalContext | null; error: string | null; denied: boolean }
class ContextReadError extends Error {
  constructor(message: string, readonly denied: boolean) { super(message); }
}
export function usePeriodontalContext({ patientId, authorityKey, visitId, refreshKey = 0 }: {
  patientId: number; authorityKey: string; visitId: number | null | undefined; refreshKey?: number | string;
}) {
  const key = JSON.stringify([patientId, authorityKey, visitId ?? null, visitId === undefined, refreshKey]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: "", status: "loading", value: null, error: null, denied: false });
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    request.current?.abort();
    if (visitId === undefined) {
      setSnapshot({ key, status: "error", value: null, error: "سياق الزيارة غير متاح. حدّث ملخص المريض قبل إدخال فحص اللثة.", denied: false });
      return;
    }
    const controller = new AbortController(); request.current = controller;
    const active = () => sequence.current === current && !controller.signal.aborted;
    setSnapshot({ key, status: "loading", value: null, error: null, denied: false });
    try {
      const read = async (url: string) => {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        // Access denial is independent of body shape, including a proxy's HTML response.
        if (!response.ok) {
          const failure = new ContextReadError("تعذّر قراءة سياق فحص اللثة؛ لا يمكن الإدخال قبل نجاح التحقق.", [401, 403, 404].includes(response.status));
          if (failure.denied && active()) setSnapshot({ key, status: "error", value: null, error: failure.message, denied: true });
          throw failure;
        }
        return response.json();
      };
      const results = await Promise.allSettled([
        visitId === null ? Promise.resolve(null) : read(`/api/visits/${visitId}/clinical`),
        read("/api/parties?kind=doctor"), read(`/api/patients/${patientId}/cases`),
      ]);
      if (!active()) return;
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw failures.find((error) => error instanceof ContextReadError && error.denied) ?? failures[0];
      const values = results.map((result) => result.status === "fulfilled" ? result.value : null);
      const value = readPeriodontalContext(patientId, visitId, values[0], values[1], values[2]);
      setSnapshot({ key, status: "ready", value, error: null, denied: false });
    } catch (error) {
      if (!active()) return;
      setSnapshot({ key, status: "error", value: null, error: error instanceof Error ? error.message : "تعذّر تحميل سياق اللثة.", denied: error instanceof ContextReadError && error.denied });
    }
  }, [patientId, visitId, key]);
  useEffect(() => {
    void reload();
    const requests = sequence; const pending = request;
    return () => { ++requests.current; pending.current?.abort(); };
  }, [reload]);
  // A changed patient/authority/visit/token cannot display a prior ready snapshot
  // for one render before effects invalidate the request.
  const current = snapshot.key === key ? snapshot : { key, status: "loading" as const, value: null, error: null, denied: false };
  return { ...current, reload };
}
