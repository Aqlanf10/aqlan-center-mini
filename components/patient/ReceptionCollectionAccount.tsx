"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { readReceptionCollectionLedger } from "@/lib/reception-collection-ledger";
import { formatMoney } from "@/lib/money";
import { EMPTY_PREVIOUS_BALANCE, PreviousBalanceFields, previousBalancePayload } from "../PreviousBalanceFields";
import { CollectPaymentModal } from "../CollectPaymentModal";
import { ReceptionDebtRepayments } from "./ReceptionDebtRepayments";
import { CheckoutDueSummary } from "./CheckoutDueSummary";

function ReceptionOpeningBalance({ patientId, onSaved }: { patientId: number; onSaved: () => void }) {
  const [draft, setDraft] = useState(EMPTY_PREVIOUS_BALANCE);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const { openingBalance } = previousBalancePayload(draft);
    if (!openingBalance || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/opening-balances", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId, ...openingBalance }),
      });
      const saved = await response.json();
      if (!response.ok) {
        setNotice(saved.message || "تعذّر تسجيل الرصيد السابق.");
        return;
      }
      if (saved.patientId !== patientId || saved.currency !== draft.currency) throw new Error("Unexpected opening balance acknowledgment");
      setDraft(EMPTY_PREVIOUS_BALANCE);
      setNotice("سُجّل الرصيد السابق.");
      onSaved();
    } catch {
      setNotice("تعذّر تأكيد تسجيل الرصيد السابق. تحقّق من العملية قبل إعادة الإرسال.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return <form onSubmit={submit}>
    <fieldset disabled={busy} className="space-y-2">
      <PreviousBalanceFields value={draft} showAccountHint={false} onChange={next => { setDraft(next); setNotice(""); }} />
      {draft.enabled && <button type="submit" disabled={!draft.amount.trim()}
        className="rounded-lg bg-navy-800 px-4 py-2 text-white">إضافة الرصيد السابق</button>}
    </fieldset>
    {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
  </form>;
}

type Ledger = Awaited<ReturnType<typeof readReceptionCollectionLedger>>;
export function ReceptionCollectionAccount({ patientId, patientName, actor }: { patientId: number; patientName: string; actor: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [message, setMessage] = useState("");
  const [debtHeld, setDebtHeld] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setRefreshing(true);
      setMessage("");
      try {
        const response = await fetch(`/api/patients/${patientId}/ledger`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok || body.patientId !== patientId) throw new Error(body.message || "تعذّر تحميل بيانات التحصيل.");
        if (!controller.signal.aborted) setLedger(body);
      } catch (error) {
        if (!controller.signal.aborted) {
          setLedger(null);
          setMessage(error instanceof Error ? error.message : "تعذّر تحميل بيانات التحصيل.");
        }
      } finally {
        if (!controller.signal.aborted) setRefreshing(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [patientId, revision]);
  const opening = <ReceptionOpeningBalance key={patientId} patientId={patientId} onSaved={() => setRevision(previous => previous + 1)} />;
  if (!ledger || ledger.patientId !== patientId) {
    return <div className="space-y-4"><p role="status">{message || "جارٍ تحميل الحساب…"}</p>{opening}</div>;
  }
  return <div className="space-y-4"><fieldset disabled={refreshing} aria-label="تحصيل المريض" className="min-w-0 space-y-4 rounded-xl bg-white p-4">
    <CheckoutDueSummary recommendation={ledger.dueRecommendation} />
    <button type="button" disabled={debtHeld} className="rounded-lg bg-emerald-700 px-4 py-2 text-white" onClick={() => setCollecting(true)}>تسجيل تحصيل</button>
    {!collecting && <ReceptionDebtRepayments patientId={patientId} actor={actor} revision={revision}
      onHold={setDebtHeld} onChanged={() => setRevision(previous => previous + 1)} />}
    {ledger.payments.length > 0 && <ul aria-label="سندات قبض الموظف لهذا المريض">
      {ledger.payments.map(row => <li key={row.id}><a className="underline" href={`/print/receipt/${row.id}`} target="_blank" rel="noopener">
        طباعة {row.receiptNumber} · {formatMoney(row.amountMinor, row.currency)}
      </a></li>)}
    </ul>}
    <CollectPaymentModal patientId={patientId} patientName={patientName} isOpen={collecting} invoices={ledger.invoices}
      plans={ledger.plans} openings={ledger.openings} onClose={() => setCollecting(false)}
      onSuccess={() => { setCollecting(false); setRevision(previous => previous + 1); }} />
  </fieldset>{opening}</div>;
}
