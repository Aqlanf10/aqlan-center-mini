import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SimilarCollectionWarning } from "../components/SimilarCollectionWarning";
import { readSimilarCollectionRefusal, type SimilarCollectionReceipt } from "../lib/similar-collection";

const operation: SimilarCollectionReceipt = { id: 41, receiptNumber: "R-41", amountMinor: 620000, currency: "YER",
  createdAt: "2026-10-21T08:00:00.000Z", method: "cash", invoiceId: 9, planId: null, openingCurrency: null, createdBy: "reception-a",
  allocations: [{ id: 41, receiptNumber: "R-41", invoiceId: 9, amountMinor: 320000, refundedMinor: 320000 },
    { id: 42, receiptNumber: "R-42", invoiceId: 10, amountMinor: 300000, refundedMinor: 0 }] };
const html = (receipts: SimilarCollectionReceipt[]) => renderToStaticMarkup(
  <SimilarCollectionWarning receipts={receipts} busy={false} onConfirm={() => {}} onCancel={() => {}} />);

describe("split collection shown as one operation with its actual receipts", () => {
  it("never attributes the operation total to the first receipt; each receipt keeps its amount, refund and own link", () => {
    const result = html([operation]);
    expect(result).toContain("عملية تحصيل واحدة موزعة على 2 سندات");
    expect(result).not.toContain("السند R-41 · 620");
    expect(result).toContain('href="/print/receipt/41"');
    expect(result).toContain('href="/print/receipt/42"');
    expect(result).toContain("مسترد");
    expect(result).toContain("(بالكامل)");
  });
  it("a refusal body is trusted only with consistent allocations led by the operation id", () => {
    const body = (receipts: unknown) => ({ reason: "similar_collection_review_required", windowHours: 24, receipts: [receipts] });
    expect(readSimilarCollectionRefusal(body(operation))).toEqual([operation]);
    expect(readSimilarCollectionRefusal(body({ ...operation, allocations: [...operation.allocations!].reverse() }))).toBeNull();
    expect(readSimilarCollectionRefusal(body({ ...operation, allocations: [operation.allocations![0]] }))).toBeNull();
    expect(readSimilarCollectionRefusal(body({ ...operation, allocations: [{ ...operation.allocations![1], refundedMinor: 300001 }, operation.allocations![0]] }))).toBeNull();
  });
});
