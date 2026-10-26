"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { acknowledgeInventoryRecoveryCommand, InventoryCommandRecoveryError, readInventoryCommandJournal, reserveInventoryRecoveryCommand, type InventoryCommandJournal } from "@/lib/inventory-command-journal";
import { createInventoryRecoveryCommand, describeInventoryRecoveryCommand, INVENTORY_RECOVERY_PROTOCOL, INVENTORY_RECOVERY_SESSION, INVENTORY_RECOVERY_STORAGE, INVENTORY_RECOVERY_UNCERTAIN, readInventoryRecoveryAcknowledgement, type InventoryRecoveryCommand, type InventoryWorkspace } from "@/lib/inventory-command-recovery";

export const INVENTORY_COMMAND_EVENT = "aqlan-inventory-command-journal-updated";
export const INVENTORY_COMMAND_DEADLINE_MS = 20_000;
type Status = "loading" | "idle" | "submitting" | "uncertain" | "blocked";
type State = { token: object | null; ready: boolean; revision: number; pending: InventoryRecoveryCommand | null; status: Status; message: string };
const empty: State = { token: null, ready: false, revision: 0, pending: null, status: "loading", message: "" };
async function boundedResponse(run: (signal: AbortSignal) => Promise<Response>): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = Promise.resolve().then(() => run(controller.signal)).then(async response => ({ response, payload: await response.json() as unknown }));
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Inventory result unconfirmed")); }, INVENTORY_COMMAND_DEADLINE_MS); });
  try { return await Promise.race([response, timeout]); } finally { clearTimeout(timer); }
}
/** A durable browser command is reserved before transport. The server's operation
 * journal still owns idempotency. Only an exact committed acknowledgement retires
 * recovery: generic 4xx, unavailable schema and revoked actors prove no outcome. */
export function useInventoryCommand(workspace: InventoryWorkspace) {
  const session = useSession(), actor = session?.username ?? "";
  const enabled = !!actor && ["admin", "reception", "doctor"].includes(session?.role ?? "");
  const token = useMemo(() => ({ actor, workspace, session }), [actor, workspace, session]);
  const [state, setState] = useState<State>(empty);
  const current = useRef<State>(empty), lifetime = useRef<object | null>(null), inFlight = useRef(false);
  const principal = useRef<{ token: object; id: number } | null>(null), readVersion = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const active = state.token === token ? state : empty;
  useLayoutEffect(() => { lifetime.current = enabled ? token : null; return () => { lifetime.current = null; }; }, [enabled, token]);
  const publish = useCallback((next: State) => {
    if (lifetime.current !== next.token) return;
    current.current = next; setState(next);
  }, []);
  const announce = () => {
    window.dispatchEvent(new Event(INVENTORY_COMMAND_EVENT));
    // Notifications carry neither identity nor document/patient information.
    try { channel.current?.postMessage("changed"); } catch { /* Focus also refreshes. */ }
  };
  const adopt = useCallback((saved: InventoryCommandJournal) => {
    if (lifetime.current !== token) return;
    const old = current.current.token === token ? current.current : { ...empty, token };
    if (old.ready && saved.revision < old.revision) return;
    // Another tab's retirement never proves the result to this tab. Keep the
    // original command for explicit replay and its own matching acknowledgement.
    if (old.pending) {
      if (!saved.command || saved.command.key === old.pending.key || inFlight.current) return;
      publish({ ...old, status: "blocked", message: new InventoryCommandRecoveryError("changed").message }); return;
    }
    if (old.ready && !saved.command && old.revision !== saved.revision) {
      publish({ ...old, status: "blocked", message: new InventoryCommandRecoveryError("changed").message }); return;
    }
    publish({ token, ready: true, revision: saved.revision, pending: saved.command,
      status: saved.command ? "uncertain" : "idle", message: saved.command ? INVENTORY_RECOVERY_UNCERTAIN : "" });
  }, [publish, token]);
  const refresh = useCallback(async () => {
    if (!enabled || lifetime.current !== token) return;
    const version = ++readVersion.current;
    try {
      const { response, payload } = await boundedResponse(signal => fetch("/api/auth/me", { cache: "no-store", redirect: "error", signal }));
      if (lifetime.current !== token || version !== readVersion.current) return;
      const identity = payload as { id?: number; username?: string; role?: string } | null;
      if (!response.ok || response.redirected || !identity || !Number.isSafeInteger(identity.id) || identity.id! <= 0
        || identity.username !== actor || identity.role !== session?.role || principal.current?.token === token && principal.current.id !== identity.id) {
        publish({ ...empty, token, status: "blocked", message: INVENTORY_RECOVERY_SESSION });
        lifetime.current = null; principal.current = null; readVersion.current += 1; return;
      }
      principal.current = { token, id: identity.id! };
      const saved = await readInventoryCommandJournal({ actor, actorUserId: identity.id!, workspace });
      if (version === readVersion.current) adopt(saved);
    } catch {
      if (lifetime.current === token && version === readVersion.current) {
        const old = current.current.token === token ? current.current : { ...empty, token };
        publish({ ...old, status: old.pending ? "uncertain" : "blocked", message: INVENTORY_RECOVERY_STORAGE });
      }
    }
  }, [actor, workspace, enabled, token, adopt, publish, session?.role]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    window.addEventListener(INVENTORY_COMMAND_EVENT, refresh); window.addEventListener("focus", refresh);
    let broadcast: BroadcastChannel | null = null;
    try { broadcast = new BroadcastChannel(INVENTORY_COMMAND_EVENT); broadcast.onmessage = () => { void refresh(); }; channel.current = broadcast; } catch { /* IDB still serializes reservations. */ }
    return () => { window.removeEventListener(INVENTORY_COMMAND_EVENT, refresh); window.removeEventListener("focus", refresh); broadcast?.close(); if (channel.current === broadcast) channel.current = null; };
  }, [enabled, refresh]);
  useEffect(() => {
    if (!active.pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [active.pending]);

  const run = async (input?: { command: string; body: Record<string, unknown> }): Promise<Record<string, unknown> | null> => {
    if (!enabled || lifetime.current !== token || inFlight.current) return null;
    const old = current.current.token === token ? current.current : empty;
    const actorUserId = principal.current?.token === token ? principal.current.id : null;
    if (!old.ready || actorUserId === null || old.status === "blocked" || old.pending && input || !old.pending && !input) return null;
    inFlight.current = true;
    let command = old.pending;
    let reservationStarted = false, reserved = false;
    const scope = { actor, actorUserId, workspace };
    try {
      command ??= await createInventoryRecoveryCommand(scope, input!.command, input!.body);
      if (lifetime.current !== token) return null;
      publish({ ...old, token, status: "submitting", message: "" });
      reservationStarted = true;
      const saved = await reserveInventoryRecoveryCommand(scope, old.revision, command);
      if (!saved.command || saved.command.key !== command.key || saved.command.body !== command.body || saved.command.digest !== command.digest) {
        publish(old.pending
          ? { ...old, token, status: "blocked", message: new InventoryCommandRecoveryError("changed").message }
          : { token, ready: true, revision: saved.revision, pending: saved.command, status: saved.command ? "uncertain" : "blocked", message: new InventoryCommandRecoveryError("changed").message });
        return null;
      }
      reserved = true;
      publish({ ...old, token, pending: command, status: "submitting", message: "" }); announce();
      if (lifetime.current !== token) return null;
      const sent = command;
      const { response, payload } = await boundedResponse(signal => {
        if (lifetime.current !== token) return Promise.reject(new Error("Inventory actor changed"));
        return fetch("/api/inventory/procurement", { method: "POST", redirect: "error", signal,
          headers: { "Content-Type": "application/json", "X-Inventory-Recovery": INVENTORY_RECOVERY_PROTOCOL,
            "X-Inventory-Actor": encodeURIComponent(sent.actor), "X-Inventory-Actor-Id": String(sent.actorUserId), "X-Inventory-Digest": sent.digest }, body: sent.body });
      });
      const result = response.ok && !response.redirected ? readInventoryRecoveryAcknowledgement(payload, command) : null;
      if (result) {
        const completed = await acknowledgeInventoryRecoveryCommand(scope, command);
        publish({ token, ready: true, revision: completed.revision, pending: null, status: "idle", message: "" }); announce();
        return lifetime.current === token ? result : null;
      }
      const message = response.status === 401 || response.status === 403 ? INVENTORY_RECOVERY_SESSION : INVENTORY_RECOVERY_UNCERTAIN;
      publish({ ...old, token, pending: command, status: "uncertain", message });
    } catch {
      if (!reservationStarted) {
        // Local snapshot/validation failure was never sent or reserved. Editing
        // is safe; no arbitrary server response can use this path.
        publish({ ...old, token, status: "idle", message: "تعذّر تجهيز العملية. راجع المدخلات وحاول مرة أخرى." });
      } else if (!reserved) {
        // The reservation result itself might have been lost. Read durable truth
        // before allowing any new operation, and never send from this error path.
        try {
          const saved = await readInventoryCommandJournal(scope);
          // A newer tab's acknowledged revision cannot erase this tab's own
          // uncertain command. Retain it and require a fresh review; no new key.
          if (old.pending) {
            const same = saved.command?.key === old.pending.key && saved.command.body === old.pending.body && saved.command.digest === old.pending.digest;
            publish({ ...old, token, status: same ? "uncertain" : "blocked", message: same ? INVENTORY_RECOVERY_UNCERTAIN : new InventoryCommandRecoveryError("changed").message });
          } else {
            publish({ token, ready: true, revision: saved.revision, pending: saved.command,
              status: saved.command ? "uncertain" : "idle", message: saved.command ? INVENTORY_RECOVERY_UNCERTAIN : INVENTORY_RECOVERY_STORAGE });
          }
        } catch { publish({ ...old, token, status: "blocked", message: INVENTORY_RECOVERY_STORAGE }); }
      } else {
        publish({ ...old, token, pending: command, status: "uncertain", message: INVENTORY_RECOVERY_UNCERTAIN });
      }
    } finally { inFlight.current = false; }
    return null;
  };
  return { status: active.status, message: active.message, locked: !enabled || active.status !== "idle", busy: active.status === "submitting",
    describe: (locale: "ar" | "en") => describeInventoryRecoveryCommand(active.pending, locale),
    send: (command: string, body: Record<string, unknown>) => run({ command, body }), retry: () => run(), refresh };
}
