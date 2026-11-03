"use client";
import { useEffect, useRef, useState } from "react";
import {
  REFERENCE_PROTOCOL,
  type ReferenceAuthority,
  type ReferenceInput,
  type ReferenceIntent,
  type ReferenceReply,
} from "@/lib/inventory-reference-protocol";
import {
  acknowledgeReferenceCommand,
  isReferenceTerminal,
  readReferenceCommand,
  reserveReferenceCommand,
} from "@/lib/inventory-reference-journal";

export function useReferenceCommand(
  authority: ReferenceAuthority | null,
  onComplete: () => void,
) {
  const token = JSON.stringify(authority),
    current = useRef(token),
    flight = useRef(false);
  current.current = token;
  useEffect(() => {
    current.current = token;
    return () => {
      current.current = "";
    };
  }, [token]);
  const [state, setState] = useState<{
    token: string;
    ready: boolean;
    revision: number;
    intent: ReferenceIntent | null;
  }>({ token: "", ready: false, revision: 0, intent: null });
  const [busyToken, setBusyToken] = useState<string | null>(null),
    [error, setError] = useState("");
  const busy = busyToken === token;
  const active = state.token === token ? state : null;
  useEffect(() => {
    if (!authority) return;
    let alive = true;
    const load = () =>
      readReferenceCommand(authority)
        .then((saved) => {
          if (alive && current.current === token)
            setState({ token, ready: true, ...saved });
        })
        .catch(() => {
          if (alive)
            setError(
              "تعذّر حفظ العملية محليًا. لا ترسل أي عملية حتى تتاح مساحة الحفظ.",
            );
        });
    void load();
    window.addEventListener("focus", load);
    window.addEventListener("inventory-reference-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
      window.removeEventListener("inventory-reference-changed", load);
    };
  }, [token, authority]);
  useEffect(() => {
    if (!active?.intent) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active?.intent]);
  async function send(
    mode: "admit" | "execute" | "lookup" | "retire",
    intent: ReferenceIntent,
    reason?: string,
  ): Promise<ReferenceReply> {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("/api/inventory/procurement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          command: `reference.${mode}`,
          intent,
          ...(reason ? { reason } : {}),
        }),
      });
      const reply = await response.json();
      if (!response.ok)
        throw new Error(
          reply.message ??
            "تعذّر تأكيد العملية. احتفظ بالمحتوى وأعد العملية نفسها.",
        );
      return reply;
    } finally {
      clearTimeout(timer);
    }
  }
  async function run(input?: ReferenceInput, retirementReason?: string) {
    if (
      !authority ||
      !active?.ready ||
      flight.current ||
      (input && active.intent)
    )
      return;
    flight.current = true;
    setBusyToken(token);
    setError("");
    try {
      const intent = active.intent ?? {
        protocol: REFERENCE_PROTOCOL,
        authority,
        nonce: crypto.randomUUID(),
        input: input!,
      };
      if (!intent.input) return;
      const saved = await reserveReferenceCommand(intent, active.revision);
      if (current.current !== token) return;
      setState({ token, ready: true, ...saved });
      window.dispatchEvent(new Event("inventory-reference-changed"));
      // Admission reply may be lost. The persisted nonce recovers the same key.
      let reply = await send("admit", intent);
      if (current.current !== token) return;
      if (!isReferenceTerminal(intent, reply))
        reply = await send(
          retirementReason ? "retire" : "execute",
          intent,
          retirementReason,
        );
      if (current.current !== token) return;
      const next = await acknowledgeReferenceCommand(intent, reply);
      setState({ token, ready: true, ...next });
      window.dispatchEvent(new Event("inventory-reference-changed"));
      onComplete();
    } catch (e) {
      if (current.current === token)
        setError(
          e instanceof Error
            ? e.message
            : "تعذّر تأكيد العملية. أعد العملية نفسها.",
        );
    } finally {
      flight.current = false;
      if (current.current === token) setBusyToken(null);
    }
  }
  return {
    ready: !!active?.ready,
    busy,
    pending: active?.intent ?? null,
    error,
    start: (input: ReferenceInput) => run(input),
    retry: () => run(),
    retire: (reason: string) => run(undefined, reason),
  };
}
