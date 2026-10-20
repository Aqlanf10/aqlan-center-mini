"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { acknowledgePurchaseCommand, PurchaseRecoveryError, readPurchaseJournal, reservePurchaseCommand, type PurchaseJournal } from "@/lib/purchase-command-journal";
import { createPurchaseCommand, purchaseInputError, PURCHASE_STORAGE_ERROR, PURCHASE_UNCERTAIN, readPurchaseReceipt, type PurchaseCommand, type PurchaseReceipt } from "@/lib/inventory-purchase-command";

export const PURCHASE_JOURNAL_EVENT = "aqlan-inventory-purchase-journal-updated";
export const PURCHASE_RESPONSE_DEADLINE_MS = 20_000;
export interface PurchaseAttempt { command: PurchaseCommand; phase: "sending" | "uncertain" | "settled"; receipt?: PurchaseReceipt }
type State = { token: object | null; ready: boolean; revision: number; attempt: PurchaseAttempt | null; error: string | null };
const empty: State = { token: null, ready: false, revision: 0, attempt: null, error: null };
export type PurchaseOutcome = { kind: "settled"; attempt: PurchaseAttempt; receipt: PurchaseReceipt }
  | { kind: "blocked" | "uncertain"; message: string } | { kind: "busy" };

async function boundedResponse(run: (signal: AbortSignal) => Promise<Response>): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = Promise.resolve().then(() => run(controller.signal)).then(async response => ({ response, payload: await response.json() as unknown }));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Purchase response unconfirmed")); }, PURCHASE_RESPONSE_DEADLINE_MS);
  });
  try { return await Promise.race([response, timeout]); }
  finally { clearTimeout(timer); }
}

function readResponse(command: PurchaseCommand, stillCurrent: () => boolean) {
  return boundedResponse(signal => {
    if (!stillCurrent()) return Promise.reject(new Error("Purchase execution owner changed"));
    return fetch(`/api/inventory/${command.itemId}/movements`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": command.key,
      "X-Purchase-Actor": encodeURIComponent(command.actor), "X-Purchase-Actor-Id": String(command.actorUserId) },
      body: command.body, signal, redirect: "error",
    });
  });
}

/** Purchase-specific, persisted-before-send recovery. A render-time disabled
 * button is useful but is not the synchronous reservation or server receipt. */
export function useDurablePurchaseAttempt(itemId: number | null) {
  const session = useSession(), actor = session?.username ?? "";
  const enabled = !!actor && itemId !== null && (session?.role === "admin" || session?.role === "reception");
  const token = useMemo(() => ({ actor, itemId, session }), [actor, itemId, session]);
  const [state, setState] = useState<State>(empty);
  const current = useRef<State>(empty), lifetime = useRef<object | null>(null), inFlight = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const principal = useRef<{ token: object; id: number } | null>(null), readVersion = useRef(0);
  const active = state.token === token ? state : empty;
  useLayoutEffect(() => { lifetime.current = enabled ? token : null; return () => { lifetime.current = null; }; }, [enabled, token]);
  const publish = useCallback((next: State) => {
    if (lifetime.current !== next.token) return;
    current.current = next; setState(next);
  }, []);
  const announce = () => {
    window.dispatchEvent(new Event(PURCHASE_JOURNAL_EVENT));
    // Notify other tabs without sharing principal or purchase contents.
    try { channel.current?.postMessage("changed"); } catch { /* Reads also run on focus. */ }
  };
  const adopt = useCallback((saved: PurchaseJournal) => {
    if (lifetime.current !== token) return;
    const old = current.current.token === token ? current.current : { ...empty, token };
    if (old.ready && saved.revision < old.revision) return;
    // Never erase a local recovery command based on another tab's retirement;
    // this tab must receive its own matching server receipt.
    if (old.attempt) {
      if (!saved.command || saved.command.key === old.attempt.command.key) {
        if (old.error) publish({ ...old, error: null });
        return;
      }
      if (inFlight.current) return;
      publish({ ...old, error: new PurchaseRecoveryError("changed").message }); return;
    }
    if (old.ready && !saved.command && old.revision !== saved.revision) {
      publish({ ...old, error: new PurchaseRecoveryError("changed").message }); return;
    }
    publish({ token, ready: true, revision: saved.revision, error: null,
      attempt: saved.command ? { command: saved.command, phase: "uncertain" } : null });
  }, [publish, token]);
  const refresh = useCallback(async () => {
    if (!enabled || itemId === null || lifetime.current !== token) return;
    const version = ++readVersion.current;
    try {
      const { response, payload: me } = await boundedResponse(signal => fetch("/api/auth/me", { cache: "no-store", redirect: "error", signal }));
      if (lifetime.current !== token || version !== readVersion.current) return;
      const identity = me as { id?: number; username?: string; role?: string } | null;
      if (!response.ok || response.redirected || !identity || !Number.isSafeInteger(identity.id) || identity.id! <= 0
        || identity.username !== actor || identity.role !== session?.role
        || principal.current?.token === token && principal.current.id !== identity.id) {
        publish({ ...empty, token, error: "تعذّر التحقق من الجلسة أو تغيّرت. أعد تحميل الصفحة وسجّل الدخول بالحساب الذي بدأ الشراء لاستعادة طلبه." });
        // Revoke this execution generation, not just the rendered view. Older
        // hashing/IDB/network continuations may clean their durable receipt but
        // must never send or publish after an observed principal change.
        lifetime.current = null;
        principal.current = null;
        readVersion.current += 1;
        return;
      }
      principal.current = { token, id: identity.id! };
      const saved = await readPurchaseJournal({ actor, actorUserId: identity.id!, itemId });
      if (version === readVersion.current) adopt(saved);
    }
    catch {
      if (lifetime.current === token && version === readVersion.current) {
        const old = current.current.token === token ? current.current : { ...empty, token };
        publish({ ...old, error: PURCHASE_STORAGE_ERROR });
      }
    }
  }, [actor, itemId, enabled, token, adopt, publish, session?.role]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    window.addEventListener(PURCHASE_JOURNAL_EVENT, refresh);
    window.addEventListener("focus", refresh);
    let broadcast: BroadcastChannel | null = null;
    try { broadcast = new BroadcastChannel(PURCHASE_JOURNAL_EVENT); broadcast.onmessage = () => { void refresh(); }; channel.current = broadcast; } catch { /* IDB still arbitrates reservations. */ }
    return () => {
      window.removeEventListener(PURCHASE_JOURNAL_EVENT, refresh); window.removeEventListener("focus", refresh);
      broadcast?.close(); if (channel.current === broadcast) channel.current = null;
    };
  }, [enabled, refresh]);
  useEffect(() => {
    if (!active.attempt || active.attempt.phase === "settled") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [active.attempt]);

  const run = async (purchase?: Record<string, unknown>): Promise<PurchaseOutcome | null> => {
    if (!enabled || itemId === null || lifetime.current !== token) return null;
    if (inFlight.current) return { kind: "busy" };
    const old = current.current.token === token ? current.current : empty;
    const actorUserId = principal.current?.token === token ? principal.current.id : null;
    if (!old.ready || old.error || actorUserId === null) return { kind: "blocked", message: old.error ?? PURCHASE_STORAGE_ERROR };
    if (old.attempt?.phase === "settled" && old.attempt.receipt) return { kind: "settled", attempt: old.attempt, receipt: old.attempt.receipt };
    if (old.attempt && purchase) return { kind: "blocked", message: PURCHASE_UNCERTAIN };
    if (!old.attempt && !purchase) return { kind: "busy" };
    if (purchase) {
      const error = purchaseInputError(purchase);
      if (error) return { kind: "blocked", message: error };
    }
    // Same-tick submits cannot pass this lock while UUID/hash/IDB are awaited.
    inFlight.current = true;
    let command = old.attempt?.command;
    let reserved = false;
    let failure = PURCHASE_UNCERTAIN;
    try {
      command ??= await createPurchaseCommand(actor, actorUserId, itemId, purchase!);
      if (lifetime.current !== token) return null;
      const attempt: PurchaseAttempt = { command, phase: "sending" };
      publish({ ...old, token, attempt });
      const saved = await reservePurchaseCommand({ actor, actorUserId, itemId }, old.revision, command);
      if (!saved.command || saved.command.key !== command.key || saved.command.body !== command.body || saved.command.digest !== command.digest) {
        publish({ token, ready: true, revision: saved.revision, error: null,
          attempt: saved.command ? { command: saved.command, phase: "uncertain" } : null });
        return lifetime.current === token ? { kind: "blocked", message: new PurchaseRecoveryError("changed").message } : null;
      }
      reserved = true; announce();
      // A principal switch/unmount may leave recoverable storage, never a fresh
      // write. The server also checks X-Purchase-Actor against its trusted session.
      if (lifetime.current !== token) return null;
      const { response, payload } = await readResponse(command, () => lifetime.current === token);
      const receipt = !response.redirected ? readPurchaseReceipt(payload, command) : null;
      if (receipt && (receipt.status === "committed" ? response.ok : [400, 404, 409].includes(response.status))) {
        const completed = await acknowledgePurchaseCommand({ actor, actorUserId, itemId }, command);
        const settled: PurchaseAttempt = { command, phase: "settled", receipt };
        publish({ token, ready: true, revision: completed.revision, attempt: settled, error: null }); announce();
        return lifetime.current === token ? { kind: "settled", attempt: settled, receipt } : null;
      }
      if (response.status === 401 || response.status === 403) failure = "تعذّر تأكيد الطلب بهذه الجلسة. سجّل الدخول بالحساب الذي بدأ الشراء ثم أعد محاولة الطلب المحفوظ نفسه.";
      if (response.status === 409) failure = "تعذّر حسم الطلب المحفوظ. لا تغيّر مفتاحه أو تُدخل شراءً بديلًا؛ راجع الإدارة ثم أعد المحاولة بالطلب نفسه.";
    } catch {
      if (!reserved) {
        // A reservation may have completed even when the caller lost its result.
        // Re-read durable truth, and never send from this error path.
        try {
          const saved = await readPurchaseJournal({ actor, actorUserId, itemId });
          publish({ token, ready: true, revision: saved.revision, attempt: saved.command ? { command: saved.command, phase: "uncertain" } : null,
            error: saved.command ? null : PURCHASE_STORAGE_ERROR });
        } catch { publish({ ...old, token, error: PURCHASE_STORAGE_ERROR }); }
        return lifetime.current === token ? { kind: "blocked", message: PURCHASE_STORAGE_ERROR } : null;
      }
    } finally { inFlight.current = false; }
    if (command) publish({ ...old, token, attempt: { command, phase: "uncertain" } });
    return lifetime.current === token ? { kind: "uncertain", message: failure } : null;
  };
  const consume = (attempt: PurchaseAttempt) => {
    const saved = current.current;
    if (lifetime.current === token && saved.token === token && saved.attempt === attempt && attempt.phase === "settled") {
      publish({ ...saved, attempt: null }); announce();
    }
  };
  return { attempt: active.attempt, ready: enabled && active.ready && !active.error, error: active.error, run, consume, refresh };
}
