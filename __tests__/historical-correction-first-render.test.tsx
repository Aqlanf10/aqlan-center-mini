/** The historical correction editor shows the stored document in its very first render. It used to
 * render empty fields and fill them in an effect after the paint; typing in that moment was merged
 * with the stored value (hosted CI, USD at 390 px: "3000" + "1300" became "30001300"). A server
 * render runs no effects, so it shows exactly what the first paint shows. Synthetic data only. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HistoricalDocumentView } from "../lib/historical-correction-view";
import { toInputAmount } from "../lib/money";

vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-owner", role: "admin" }) }));
const { HistoricalCorrection } = await import("../components/HistoricalCorrection");

const original: HistoricalDocumentView = { id: 1, version: 1, revisionId: 2, patientId: 9, currency: "USD", createdBy: "synthetic-owner", idempotencyKey: "history-original",
  reason: "Synthetic agreement", totalMinor: 300000, discountMinor: 5000, discountReason: "SYN discount", agreedMinor: 295000, previouslyPaidMinor: 120000, remainingMinor: 175000,
  historicalAsOf: "2026-10-01", note: "SYN note",
  lines: [{ agreementId: 5, planItemId: 6, planId: 88, caseId: 77, serviceId: 7, doctorId: null, description: "Synthetic RCT", toothCode: 16,
    site: { mode: "per_tooth_episode", toothCode: 16, surfaces: null, scope: null, episodeTeeth: null }, unitPriceMinor: 300000, discountMinor: 5000, netMinor: 295000 }],
  repayment: { arrangementId: 3, revisionId: 4, version: 1, terms: { mode: "full", installments: [] } }, openingPrincipalMinor: 175000, openingCollectedMinor: 20000,
  openingRemainingMinor: 155000, accountDueMinor: 155000, scheduleVersion: 1, sourceHash: "a".repeat(64), correctionAvailable: true, correctionMessage: null,
  history: [{ version: 1, reason: "Synthetic agreement", created_by: "synthetic-owner" }] } as unknown as HistoricalDocumentView;

describe("historical correction editor: first render", () => {
  it("shows the stored price, discount, paid amount, date and note before any effect runs", () => {
    const html = renderToStaticMarkup(createElement(HistoricalCorrection, { original, recovery: null, onRecoveryChange: () => {},
      financialRecovery: { revision: 0 } as never, onDone: () => {}, onCancel: () => {} }));
    const valueOf = (label: string) => new RegExp(`aria-label="${label}"[^>]*value="([^"]*)"`).exec(html)?.[1];
    expect(valueOf("سعر تصحيح الاتفاق 1")).toBe(toInputAmount(300000, "USD"));
    expect(valueOf("خصم تصحيح الاتفاق")).toBe(toInputAmount(5000, "USD"));
    expect(valueOf("سبب خصم الاتفاق")).toBe("SYN discount");
    expect(valueOf("المدفوع السابق المصحح")).toBe(toInputAmount(120000, "USD"));
    expect(valueOf("سعر تصحيح الاتفاق 1")).not.toBe("");
    expect(valueOf("تاريخ الاتفاق المصحح")).toBe("2026-10-01");
  });
});
