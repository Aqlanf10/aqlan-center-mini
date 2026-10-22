import { describe, expect, it } from "vitest";
import { quoteAgreementAmendment, type AgreementAmendmentProposal } from "../lib/agreement-amendment-quote";
const source: AgreementAmendmentProposal = {
  currency: "YER", previousServiceId: 11, selectedServiceId: 22,
  quantity: 10, previousUnitPriceMinor: 50_000, selectedUnitPriceMinor: 80_000,
  previousAgreementMinor: 500_000, recordedPaymentsMinor: 180_000,
  recordedRefundsMinor: 0, reason: "Patient approved documented zirconia upgrade",
};
describe("financially isolated amendment quote (not a posting API)", () => {
  it("calculates exact 300k increase, 800k revised agreement and 620k due", () => {
    const q = quoteAgreementAmendment(source);
    expect([q.oldTreatmentMinor, q.newTreatmentMinor, q.deltaMinor,
      q.revisedAgreementMinor, q.settledMinor, q.remainingMinor])
      .toEqual([500_000, 800_000, 300_000, 800_000, 180_000, 620_000]);
    expect(q.financialEventKind).toBe("agreement_delta");
  });
  it("requires selecting a service regardless of price or text in the reason", () => {
    expect(() => quoteAgreementAmendment({...source, selectedServiceId: 0, reason: "زركون"})).toThrow();
    expect(quoteAgreementAmendment({...source,selectedServiceId:11}).selectedServiceId).toBe(11);
  });
  it("keeps the existing discount in net principal and applies ONLY the price difference", () => {
    const q = quoteAgreementAmendment({...source, previousAgreementMinor:450_000});
    expect([q.deltaMinor,q.revisedAgreementMinor,q.remainingMinor]).toEqual([300_000,750_000,570_000]);
  });
  it("reduces settlement on refund immediately, without treating refund as commission review", () => {
    const q = quoteAgreementAmendment({...source,recordedRefundsMinor:20_000});
    expect([q.settledMinor,q.remainingMinor,q.financialEventKind]).toEqual([160_000,640_000,"agreement_delta"]);
  });
  it.each(["YER","SAR","USD"] as const)("keeps %s in native currency without fabricating FX",currency=>{
    const q = quoteAgreementAmendment({...source,currency});
    expect(q.currency).toBe(currency);
    expect(q.remainingMinor).toBe(620_000);
  });
  it("shows unallocated credit explicitly on a downward amendment", () => {
    const q = quoteAgreementAmendment({...source, selectedUnitPriceMinor:10_000,
      previousAgreementMinor:500_000,recordedPaymentsMinor:450_000});
    expect([q.revisedAgreementMinor,q.remainingMinor,q.creditMinor]).toEqual([100_000,0,350_000]);
  });
  it("rejects impossible debt and unsafe arithmetic rather than rounding",()=>{
    expect(()=>quoteAgreementAmendment({...source,recordedRefundsMinor:180_001})).toThrow();
    expect(()=>quoteAgreementAmendment({...source,quantity:Number.MAX_SAFE_INTEGER})).toThrow();
    expect(quoteAgreementAmendment({...source,previousAgreementMinor:1}).revisedAgreementMinor).toBe(300_001);
    // A negative principal requires an actual reduction, not the positive upgrade.
    expect(()=>quoteAgreementAmendment({...source,previousAgreementMinor:1,selectedUnitPriceMinor:10_000})).toThrow();
  });
  it("refuses an unchanged price/service and will not invent a financial event",()=>{
    expect(()=>quoteAgreementAmendment({...source,selectedServiceId:11,selectedUnitPriceMinor:50_000})).toThrow();
  });
});
