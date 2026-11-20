"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PatientNumberingSaveCandidate } from "./PatientNumberingSaveCandidate";
import { numberingDraft } from "./patient-numbering-preview-model";
import { isCommandRevision, isDefiniteSaveRefusal, type NumberingSaveOperations } from "./patient-numbering-save-model";
import {
  clearNumberingReceipt, readPendingNumberingReceipt, rememberNumberingReceipt, type NumberingReceiptStorage,
} from "./patient-numbering-receipt-journal";
import {
  isNumberingRequestId, type NumberingSettingsTransport, type SettingsNumberingReceipt, type SettingsNumberingCurrent,
} from "../../lib/patient-numbering-settings-contract";

type TransportScope = { transport: NumberingSettingsTransport | null };
type VerifiedRead = { id: string; scope: TransportScope };
type Epoch = { scope: TransportScope; request: number; gate: VerifiedRead | null };
type View = { kind: "loading" | "held" } | {
  kind: "verified"; gate: VerifiedRead; current: SettingsNumberingCurrent;
  receipt: SettingsNumberingReceipt | null;
};
function sessionStore(): NumberingReceiptStorage | null {
  try { return window.sessionStorage; } catch { return null; }
}
/** Private settings host, not mounted in the Next settings route. The future
 * authenticated transport is explicit; absence never creates a network call. */
export function PatientNumberingSettingsHost({ transport = null }: { transport?: NumberingSettingsTransport | null }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const scope = useMemo<TransportScope>(() => ({ transport }), [transport]);
  const lifetime = useRef<Epoch | null>(null);
  const refresh = useCallback(async () => {
    const epoch = lifetime.current;
    if (!scope.transport || !epoch || epoch.scope !== scope) return;
    const trial = ++epoch.request;
    epoch.gate = null;
    const storage = sessionStore();
    const pending = readPendingNumberingReceipt(storage);
    if (!pending.ok) { setView({ kind: "held" }); return; }
    setView({ kind: "loading" });
    try {
      const result = await scope.transport.read(pending.requestId);
      if (epoch !== lifetime.current || trial !== epoch.request) return;
      const now = readPendingNumberingReceipt(storage);
      const current = result?.ok ? result.current : null;
      const parsed = current && typeof current.prefix === "string" && typeof current.next === "string"
        ? numberingDraft(current.prefix, current.next) : null;
      if (!now.ok || now.requestId !== pending.requestId || !result?.ok || !isNumberingRequestId(result.readId)
        || !current || typeof current.prefix !== "string" || !/^[A-Z]$/.test(current.prefix)
        || !isCommandRevision(current.revision)
        || (current.next !== null && (!parsed || parsed.prefix !== current.prefix || parsed.next !== current.next))) {
        setView({ kind: "held" }); return;
      }
      const receipt = result.receipt;
      if (pending.requestId) {
        const value = receipt?.value;
        const number = value && typeof value.prefix === "string" && typeof value.next === "string"
          ? numberingDraft(value.prefix, value.next) : null;
        if (receipt?.requestId !== pending.requestId || !value || !number || number.prefix !== value.prefix
          || number.next !== value.next || number.preview !== value.preview || !isCommandRevision(value.revision)
          || !clearNumberingReceipt(storage, pending.requestId)) { setView({ kind: "held" }); return; }
      } else if (receipt !== null) { setView({ kind: "held" }); return; }
      const gate = { id: result.readId, scope };
      epoch.gate = gate;
      setView({ kind: "verified", gate, current, receipt });
    } catch { if (epoch === lifetime.current && trial === epoch.request) setView({ kind: "held" }); }
  }, [scope]);
  useLayoutEffect(() => {
    const epoch: Epoch = { scope, request: 0, gate: null };
    lifetime.current = epoch;
    queueMicrotask(() => { if (lifetime.current === epoch && !epoch.request) void refresh(); });
    return () => { if (lifetime.current === epoch) lifetime.current = null; };
  }, [refresh, scope]);

  const gate = view.kind === "verified" && view.gate.scope === scope ? view.gate : null;
  const operations = useMemo<NumberingSaveOperations | undefined>(() => transport && gate ? ({
    preview: draft => lifetime.current?.gate === gate
      ? transport.preview(draft) : Promise.resolve({ ok: false, reason: "stale-preview" }),
    async save(ticket) {
      const epoch = lifetime.current;
      if (!epoch || epoch.gate !== gate) return { ok: false, reason: "idempotency-conflict" };
      const storage = sessionStore();
      const attempt = rememberNumberingReceipt(storage, ticket.requestId);
      if (attempt === "hold") return { ok: false, reason: "idempotency-conflict" };
      const trial = ++epoch.request;
      const result = await transport.save(ticket);
      // Only a first attempt with an authoritative pre-write denial may be
      // removed. An uncertain send stays held until read confirms its receipt.
      if (lifetime.current === epoch && trial === epoch.request && epoch.gate === gate
        && attempt === "first" && result?.ok === false && isDefiniteSaveRefusal(result.reason)) {
        clearNumberingReceipt(storage, ticket.requestId);
      }
      return result;
    },
  }) : undefined, [transport, gate]);

  if (!transport) return <p dir="rtl">تغيير ترقيم الملفات غير مفعّل.</p>;
  if (view.kind === "verified" && view.gate.scope === scope) return <div>
    {view.receipt && <p dir="rtl" role="status">
      تأكد حفظ الطلب السابق: <bdi dir="ltr">{view.receipt.value.preview}</bdi>. هذه نتيجة سابقة وليست الرقم التالي الآن.
    </p>}
    <PatientNumberingSaveCandidate key={view.gate.id} current={view.current} operations={operations}
      readGate={{ state: "verified", readId: view.gate.id }} onRequestReconciliation={() => void refresh()} />
  </div>;
  if (view.kind === "held") return <section dir="rtl">
    <p role="status">لم تتأكد حالة الترقيم أو نتيجة الطلب السابق. الحفظ متوقف حتى تتم المراجعة.</p>
    <button type="button" onClick={() => void refresh()}>مراجعة حالة الترقيم</button>
  </section>;
  return <p dir="rtl" role="status">جارٍ التحقق من حالة الترقيم…</p>;
}
