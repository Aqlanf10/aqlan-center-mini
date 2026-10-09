import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CollectPaymentModal } from "../../components/CollectPaymentModal";
import { ReceiptCorrection } from "../../components/ReceiptCorrection";
import { SessionProvider, useSessionActions } from "../../components/SessionProvider";

type Pending = { url: string; key: string; body: string; resolve: (response: Response) => void; reject: () => void };
const pending: Pending[] = [];
const successes: { patientId: number; id: number | null }[] = [];
window.fetch = (input, init) => new Promise<Response>((resolve, reject) => {
  const url = String(input);
  if (init?.method !== "POST" || !/^\/api\/payments(?:\/\d+\/correct)?$/.test(url)) {
    reject(new Error("Unexpected fixture request")); return;
  }
  pending.push({ url, key: new Headers(init.headers).get("Idempotency-Key") ?? "", body: String(init.body), resolve, reject: () => reject(new Error("Synthetic disconnect")) });
});
const api = {
  snapshot: () => ({ requests: pending.map(({ url, key, body }) => ({ url, key, body })), successes }),
  reply: (index: number, body: string, status = 201) => pending[index].resolve(new Response(body, { status, headers: { "Content-Type": "application/json" } })),
  fail: (index: number) => pending[index].reject(),
};
declare global { interface Window { __moneyFixture: typeof api } }
window.__moneyFixture = api;
function Controls() {
  const [patientId, setPatientId] = useState(101), [open, setOpen] = useState(true), [mounted, setMounted] = useState(true);
  const [invoice, setInvoice] = useState(false), [correction, setCorrection] = useState(false);
  const { setSession } = useSessionActions();
  return <>
    <button id="patient-a" onClick={() => setPatientId(101)}>Patient A</button>
    <button id="patient-b" onClick={() => setPatientId(102)}>Patient B</button>
    <button id="open" onClick={() => setOpen(true)}>Open</button>
    <button id="close" onClick={() => setOpen(false)}>Close externally</button>
    <button id="mount" onClick={() => setMounted((value) => !value)}>Mount</button>
    <button id="target" onClick={() => setInvoice((value) => !value)}>Change target</button>
    <button id="correction" onClick={() => setCorrection((value) => !value)}>Correction</button>
    <button id="principal" onClick={() => setSession({ username: "synthetic-other", role: "admin" })}>Principal B</button>
    {mounted && !correction ? <CollectPaymentModal patientId={patientId} patientName={`Synthetic ${patientId}`} isOpen={open}
      presetInvoice={invoice ? { id: 201, baseCurrency: "YER" } : null}
      onClose={() => setOpen(false)} onSuccess={(id) => { successes.push({ patientId, id }); setOpen(false); }} /> : null}
    {mounted && correction && open ? <ReceiptCorrection receipt={{ id: patientId + 500, receiptNumber: "SYN-P", amountMinor: 500, currency: "YER", method: "cash", invoiceId: null }}
      remainingMinor={500} invoices={[]} plans={[]} openingCurrencies={[]} onCancel={() => setOpen(false)}
      onDone={(_message, id) => { successes.push({ patientId, id }); setOpen(false); }} /> : null}
  </>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><SessionProvider value={{ username: "synthetic-money", role: "admin" }}><Controls /></SessionProvider></StrictMode>);
