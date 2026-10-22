import { describe, expect, it } from "vitest";
import { readOpeningCorrectionPreview } from "../components/OpeningCorrectionPreview";

const reply = (extra: Record<string, unknown> = {}) => ({ preview: {
  patientId: 41, currency: "YER", currentAmountMinor: 100_000, currentAsOfDate: "2026-01-01", settledMinor: 60_000, receiptCount: 1,
  afterAmountMinor: 40_000, currentRemainingMinor: 40_000, afterRemainingMinor: 0, allowed: false, code: "below_settled",
  message: "المبلغ المصحّح أقل من المحصّل المثبت على هذا الرصيد.", ...extra } });

describe("FIN-INT legacy dry-run reader", () => {
  it("keeps only the shown figures", () => {
    expect(readOpeningCorrectionPreview({ ...reply(), secret: "PRIVATE" }, "YER")).toEqual({
      currentAmountMinor: 100_000, settledMinor: 60_000, receiptCount: 1, afterAmountMinor: 40_000,
      currentRemainingMinor: 40_000, afterRemainingMinor: 0, allowed: false, message: "المبلغ المصحّح أقل من المحصّل المثبت على هذا الرصيد." });
    expect(readOpeningCorrectionPreview(reply({ afterAmountMinor: null, allowed: true, code: null, message: null }), "YER"))
      .toMatchObject({ afterAmountMinor: null, allowed: true, message: null });
  });
  it.each([
    ["another currency", { currency: "SAR" }], ["allowed with a refusal", { allowed: true }], ["refused without a message", { message: null }],
    ["a fractional amount", { settledMinor: 1.5 }], ["a negative remaining", { afterRemainingMinor: -1 }], ["a string count", { receiptCount: "1" }],
  ])("fails closed on %s", (_label, extra) => {
    expect(() => readOpeningCorrectionPreview(reply(extra), "YER")).toThrow();
  });
  it.each([null, {}, { preview: [] }, { preview: null }])("fails closed on a malformed body %j", (body) => {
    expect(() => readOpeningCorrectionPreview(body, "YER")).toThrow();
  });
});
