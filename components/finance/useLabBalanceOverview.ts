"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LAB_BALANCE_VIEW, readLabBalanceOverview, type LabBalanceOverview, type LabBalanceReadState } from "@/lib/lab-balance-overview";

type Owner = { scope: object; active: boolean; sequence: number; controller: AbortController | null; snapshot: LabBalanceOverview | null };
type Snapshot = { scope: object; phase: "loading" | "ready" | "error"; data: LabBalanceOverview | null };

/** The page calls reload with its refresh workflow. A new principal creates a
 * new owner even for A → B → A; stale completions never recover old money. */
export function useLabBalanceOverview(authorityKey: string | null) {
  const scope = useMemo(() => ({ key: authorityKey }), [authorityKey]);
  const lease = useRef<Owner | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useLayoutEffect(() => {
    const owner: Owner = { scope, active: true, sequence: 0, controller: null, snapshot: null };
    lease.current = owner;
    return () => { owner.active = false; owner.sequence++; owner.snapshot = null; owner.controller?.abort();
      if (lease.current === owner) lease.current = null; };
  }, [scope]);
  const reload = useCallback(async () => {
    const owner = lease.current;
    if (!owner?.active || owner.scope !== scope || !scope.key) return;
    const sequence = ++owner.sequence;
    owner.controller?.abort(); owner.snapshot = null;
    const controller = new AbortController(); owner.controller = controller;
    const current = () => lease.current === owner && owner.active && owner.sequence === sequence && !controller.signal.aborted;
    setSnapshot({ scope, phase: "loading", data: null });
    try {
      const response = await fetch(`/api/finance/lab-reconciliation?view=${LAB_BALANCE_VIEW}`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      if (!response.ok) throw new Error("Lab balances unavailable");
      const payload: unknown = await response.json();
      if (!current()) return;
      const data = readLabBalanceOverview(payload);
      owner.snapshot = data; setSnapshot({ scope, phase: "ready", data });
    } catch {
      if (current()) setSnapshot({ scope, phase: "error", data: null });
    }
  }, [scope]);
  let state: LabBalanceReadState = { phase: authorityKey ? "loading" : "unavailable", data: null };
  if (authorityKey && snapshot?.scope === scope) {
    if (snapshot.phase === "ready" && snapshot.data) state = { phase: "ready", data: snapshot.data };
    else if (snapshot.phase === "error") state = { phase: "error", data: null };
  }
  return { state, reload };
}
