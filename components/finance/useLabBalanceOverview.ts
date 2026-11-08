"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LAB_BALANCE_VIEW, readLabBalanceOverview, type LabBalanceOverview, type LabBalanceReadState } from "@/lib/lab-balance-overview";

type Owner = { key: string | null };
type ReadLifetime = { owner: Owner; sequence: number; controller: AbortController | null };
type Snapshot = { owner: Owner; phase: "loading" | "ready" | "error"; data: LabBalanceOverview | null };

/** The page calls reload with its refresh workflow. A new principal creates a
 * new owner even for A → B → A; stale completions never recover old money. */
export function useLabBalanceOverview(authorityKey: string | null) {
  const owner = useMemo<Owner>(() => ({ key: authorityKey }), [authorityKey]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const lifetime = useRef<ReadLifetime | null>(null);
  useLayoutEffect(() => {
    const committed: ReadLifetime = { owner, sequence: 0, controller: null };
    lifetime.current = committed;
    return () => {
      committed.controller?.abort();
      if (lifetime.current === committed) lifetime.current = null;
    };
  }, [owner]);
  const reload = useCallback(async () => {
    const committed = lifetime.current;
    if (!committed || committed.owner !== owner || !owner.key) return;
    const sequence = ++committed.sequence;
    committed.controller?.abort();
    const controller = new AbortController(); committed.controller = controller;
    const current = () => lifetime.current === committed && committed.sequence === sequence && !controller.signal.aborted;
    setSnapshot({ owner, phase: "loading", data: null });
    try {
      const response = await fetch(`/api/finance/lab-reconciliation?view=${LAB_BALANCE_VIEW}`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      if (!response.ok) throw new Error("Lab balances unavailable");
      const payload: unknown = await response.json();
      if (!current()) return;
      const data = readLabBalanceOverview(payload);
      setSnapshot({ owner, phase: "ready", data });
    } catch {
      if (current()) setSnapshot({ owner, phase: "error", data: null });
    }
  }, [owner]);
  let state: LabBalanceReadState = { phase: authorityKey ? "loading" : "unavailable", data: null };
  if (authorityKey && snapshot?.owner === owner) {
    if (snapshot.phase === "ready" && snapshot.data) state = { phase: "ready", data: snapshot.data };
    else if (snapshot.phase === "error") state = { phase: "error", data: null };
  }
  return { state, reload };
}
