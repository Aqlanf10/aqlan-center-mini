"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SUPPLIER_PROTOCOL,
  type SupplierIntent,
  type SupplierAdmissionResult,
  type SupplierAcknowledgement,
  type SupplierAction,
  type SupplierInput,
} from "@/lib/inventory-supplier-protocol";
import type { StaffIdentityClaims } from "@/lib/staff-authenticated-identity";
import {
  acknowledgeSupplierCommand,
  acknowledgeSupplierRejection,
  listSupplierCommands,
  saveSupplierCommand,
  type SupplierSavedCommand,
} from "@/lib/inventory-supplier-journal";
import { inventoryRecoveryIdentity } from "@/lib/inventory-command-recovery";
async function send(body: object) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("/api/inventory/procurement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        typeof payload.code === "string"
          ? payload.code
          : "supplier_result_uncertain",
      );
    return payload;
  } finally {
    clearTimeout(timer);
  }
}
export function useSupplierCommand(
  authority: StaffIdentityClaims | null,
  onSuccess: () => void,
) {
  const [saved, setSaved] = useState<SupplierSavedCommand[]>([]),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(authority);
  live.current = authority;
  const inFlight = useRef(false);
  const realm = authority?.realmId,
    subject = authority?.subjectId,
    epoch = authority?.executionEpochId;
  const refresh = useCallback(async () => {
    if (!realm || !subject) {
      setReady(false);
      return;
    }
    try {
      const rows = await listSupplierCommands(realm, subject);
      if (
        live.current?.realmId === realm &&
        live.current.subjectId === subject
      ) {
        setSaved(rows);
        setReady(true);
      }
    } catch {
      setError("supplier_storage_unavailable");
      setReady(false);
    }
  }, [realm, subject]);
  useEffect(() => {
    setReady(false);
    setSaved([]);
    void refresh();
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("inventory-supplier-recovery")
        : null;
    const changed = () => void refresh();
    channel?.addEventListener("message", changed);
    window.addEventListener("focus", changed);
    return () => {
      channel?.close();
      window.removeEventListener("focus", changed);
    };
  }, [refresh, epoch]);
  const announce = () => {
    try {
      const c = new BroadcastChannel("inventory-supplier-recovery");
      c.postMessage("changed");
      c.close();
    } catch {}
  };
  const run = async (existing: SupplierSavedCommand, retireReason?: string) => {
    if (!ready || inFlight.current || !authority) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    let command = existing;
    try {
      await saveSupplierCommand(command);
      await refresh();
      announce();
      if (!command.admission) {
        const admission = (await send({
          command: "supplier.admit",
          intent: command.intent,
        })) as SupplierAdmissionResult;
        if ("status" in admission) {
          await acknowledgeSupplierRejection(command, admission);
          announce();
          await refresh();
          setError(admission.code);
          return false;
        }
        const {
          operationKey: _,
          actorUserId: __,
          username: ___,
          ...returnedIntent
        } = admission.envelope;
        if (
          inventoryRecoveryIdentity(returnedIntent) !==
          inventoryRecoveryIdentity(command.intent)
        )
          throw new Error("supplier_acknowledgement_mismatch");
        command = { ...command, admission };
        await saveSupplierCommand(command);
        await refresh();
        announce();
      }
      const ack = (await send({
        command:
          retireReason === undefined ? "supplier.execute" : "supplier.retire",
        admission: command.admission,
        ...(retireReason === undefined ? {} : { reason: retireReason }),
      })) as SupplierAcknowledgement;
      await acknowledgeSupplierCommand(command, ack);
      announce();
      await refresh();
      if (
        live.current?.realmId === authority.realmId &&
        live.current.subjectId === authority.subjectId &&
        live.current.executionEpochId === authority.executionEpochId
      )
        onSuccess();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "supplier_result_uncertain");
      await refresh();
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const start = async (action: SupplierAction, input: SupplierInput) => {
    if (!authority || inFlight.current) return false;
    try {
      const pending = await listSupplierCommands(
        authority.realmId,
        authority.subjectId,
      );
      if (pending.some((s) => s.intent.input.invoiceId === input.invoiceId)) {
        setSaved(pending);
        setError("supplier_invoice_intent_pending");
        return false;
      }
    } catch {
      setError("supplier_storage_unavailable");
      return false;
    }
    const intent: SupplierIntent = {
      protocol: SUPPLIER_PROTOCOL,
      authority: { ...authority },
      nonce: crypto.randomUUID(),
      action,
      input: JSON.parse(JSON.stringify(input)) as SupplierInput,
    };
    return run({ intent });
  };
  return {
    saved,
    ready,
    busy,
    error,
    start,
    retry: (s: SupplierSavedCommand) => run(s),
    retire: (s: SupplierSavedCommand, reason: string) => run(s, reason),
  };
}
