import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import TreatmentFinancialContext, { type TreatmentFinancialContextProps } from "../../components/TreatmentFinancialContext";
import { projectTreatmentFinancialReferences } from "../../lib/treatment-financial-context";

type Props = Omit<TreatmentFinancialContextProps, "onOpenClinicalContext">;
const requests: { id: number; url: string; signal: AbortSignal | null; resolve: (response: Response) => void }[] = [];
let setProps: (props: Props) => void = () => { throw new Error("Fixture not mounted"); };
// Intentionally deliver bodies after cancellation; the real component must fence them itself.
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
  requests.push({ id: requests.length + 1, url: String(input), signal: init?.signal ?? null, resolve });
})) as typeof fetch;
const payload = (patientId: number, marker: string) => projectTreatmentFinancialReferences({
  patientId,
  plans: [{ id: 1, patientId, currency: "YER", totalMinor: 1000, status: "active", billingMode: "per_procedure", hasInstallments: false }],
  items: [{ patientId, planId: 1, planItemId: 2, clinicalCaseId: 3, orthoCaseId: 4, origin: "invoice",
    originInvoiceId: 5, billedInvoiceId: 5, billingStatus: "billed", financialReviewRequired: false,
    hasInvoiceLineage: true, hasLegacyLineage: false, legacyCoverageState: "none" }],
  invoices: [{ id: 5, patientId, planId: null, invoiceNumber: marker, currency: "YER", totalMinor: 1000, discountMinor: 0, status: "open" }],
  lines: [{ id: 6, invoiceId: 5, planItemId: 2, sourceType: "plan_item", sourceId: 2, totalMinor: 1000 }],
  receipts: [], legacyAgreements: [], openings: [],
});
declare global {
  interface Window {
    __financialOwner: {
      set(props: Props): void;
      requests(): { id: number; url: string; aborted: boolean }[];
      respond(id: number, patientId: number, marker: string, status?: number): void;
    };
  }
}
window.__financialOwner = {
  set: (props) => setProps(props),
  requests: () => requests.map((request) => ({ id: request.id, url: request.url, aborted: request.signal?.aborted ?? false })),
  respond: (id, patientId, marker, status = 200) => {
    const request = requests.find((one) => one.id === id);
    if (!request) throw new Error("Unknown synthetic request");
    request.resolve(new Response(JSON.stringify(status === 200 ? payload(patientId, marker) : { message: "Synthetic denied read" }), { status }));
  },
};
function Fixture() {
  const [props, update] = useState<Props>({ patientId: 11, canView: true, authorityKey: "A" });
  useLayoutEffect(() => { setProps = update; }, []);
  return <div id="financial-owner-fixture"><TreatmentFinancialContext {...props} /></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
