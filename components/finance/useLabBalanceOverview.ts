"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LAB_BALANCE_VIEW, readLabBalanceOverview, type LabBalanceOverview, type LabBalanceReadState } from "@/lib/lab-balance-overview";

type Owner = { key: string | null; active: boolean; sequence: number; controller: AbortController | null; snapshot: LabBalanceOverview | null };
type Snapshot = { owner: Owner; phase: "loading" | "ready" | "error"; data: LabBalanceOverview | null };

/** The page calls reload with its refresh workflow. A new principal creates a
 * new owner even for A → B → A; stale completions never recover old money. */
export function useLabBalanceOverview(authorityKey: string | null) {
  const owner = useMemo<Owner>(() => ({ key: authorityKey, active: false, sequence: 0, controller: null, snapshot: null }), [authorityKey]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    owner.active = true;
    return () => { owner.active = false; owner.sequence++; owner.snapshot = null; owner.controller?.abort(); };
  }, [owner]);
  const reload = useCallback(async () => {
    if (!owner.active || !owner.key) return;
    const sequence = ++owner.sequence;
    owner.controller?.abort(); owner.snapshot = null;
    const controller = new AbortController(); owner.controller = controller;
    const current = () => owner.active && owner.sequence === sequence && !controller.signal.aborted;
    setSnapshot({ owner, phase: "loading", data: null });
    try {
      const response = await fetch(`/api/finance/lab-reconciliation?view=${LAB_BALANCE_VIEW}`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      if (!response.ok) throw new Error("Lab balances unavailable");
      const payload: unknown = await response.json();
      if (!current()) return;
      const data = readLabBalanceOverview(payload);
      owner.snapshot = data; setSnapshot({ owner, phase: "ready", data });
    } catch {
      if (current()) setSnapshot({ owner, phase: "error", data: null });
    }
  }, [owner]);
  let state: LabBalanceReadState = { phase: authorityKey ? "loading" : "unavailable", data: null };
  if (authorityKey && owner.active && snapshot?.owner === owner) {
    if (snapshot.phase === "ready" && snapshot.data && owner.snapshot === snapshot.data) state = { phase: "ready", data: snapshot.data };
    else if (snapshot.phase === "error") state = { phase: "error", data: null };
  }
  return { state, reload };
}
