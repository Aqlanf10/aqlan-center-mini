import { describe, expect, it, vi } from "vitest";
import { MoneyAttemptStore, type MoneyRequest } from "../lib/money-attempt";
import {
  formatSimilarCollectionReviewHeader, parseSimilarCollectionReviewHeader, readSimilarCollectionRefusal,
  SIMILAR_COLLECTION_REVIEW_HEADER, type SimilarCollectionReceipt,
} from "../lib/similar-collection";

const payment: MoneyRequest = { url: "/api/payments", body: JSON.stringify({ patientId: 101, amount: "500", currency: "YER", kind: "payment" }), operation: "payment" };
const receipt: SimilarCollectionReceipt = { id: 41, receiptNumber: "R-41", amountMinor: 500, currency: "YER", createdAt: "2026-10-21T08:00:00.000Z",
  method: "cash", invoiceId: 9, planId: null, openingCurrency: null, createdBy: "reception-a" };
const similar = (receipts: SimilarCollectionReceipt[] = [receipt]) => Response.json(
  { reason: "similar_collection_review_required", message: "يوجد سند مشابه", windowHours: 24, receipts }, { status: 409 });
const ok = (id = 702) => Response.json({ id }, { status: 201 });
const headerOf = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>)[SIMILAR_COLLECTION_REVIEW_HEADER];

describe("review header grammar", () => {
  it("absent, empty or 'none' means the operator saw no similar receipt", () => {
    for (const value of [null, "", "none", " none "]) expect(parseSimilarCollectionReviewHeader(value)).toEqual({ observedReceiptIds: [] });
  });
  it("accepts the exact reported order of up to 32 distinct positive ids, refuses anything else", () => {
    expect(parseSimilarCollectionReviewHeader("ids:7,3")).toEqual({ observedReceiptIds: [7, 3] });
    const many = Array.from({ length: 32 }, (_, i) => i + 1);
    expect(parseSimilarCollectionReviewHeader(`ids:${many.join(",")}`)?.observedReceiptIds).toHaveLength(32);
    for (const bad of ["ids:", "ids:0", "ids:1,1", "ids:-1", "ids:1;2", "yes", "ids:1, 2", `ids:${[...many, 33].join(",")}`]) {
      expect(parseSimilarCollectionReviewHeader(bad), bad).toBeNull();
    }
    expect(formatSimilarCollectionReviewHeader({ observedReceiptIds: [] })).toBe("none");
    expect(formatSimilarCollectionReviewHeader({ observedReceiptIds: [7, 3] })).toBe("ids:7,3");
  });
  it("a refusal body is trusted only when complete", () => {
    expect(readSimilarCollectionRefusal({ reason: "similar_collection_review_required", windowHours: 24, receipts: [receipt] })).toEqual([receipt]);
    expect(readSimilarCollectionRefusal({ reason: "similar_collection_review_required", windowHours: 24, receipts: [] })).toEqual([]);
    expect(readSimilarCollectionRefusal({ reason: "other", windowHours: 24, receipts: [receipt] })).toBeNull();
    expect(readSimilarCollectionRefusal({ reason: "similar_collection_review_required", windowHours: 24, receipts: [{ ...receipt, id: 0 }] })).toBeNull();
    expect(readSimilarCollectionRefusal({ reason: "similar_collection_review_required", receipts: [receipt] })).toBeNull();
  });
});

describe("attempt store keeps the key through an advisory review", () => {
  it("confirmation resends the SAME body and key with the reviewed ids; the review never enters the body", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(similar()).mockResolvedValueOnce(ok());
    const store = new MoneyAttemptStore(transport, () => "synthetic-key-001");
    expect(await store.run("a", payment)).toEqual({ kind: "similar", receipts: [receipt] });
    expect(store.get("a")).toMatchObject({ phase: "review", key: "synthetic-key-001", similar: { proven: true } });
    const done = await store.run("a", undefined, { observedReceiptIds: [41] });
    expect(done.kind).toBe("confirmed");
    const [first, second] = transport.mock.calls;
    expect(second[0]).toBe(first[0]);
    expect((second[1] as RequestInit).body).toBe((first[1] as RequestInit).body);
    expect(((second[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"]).toBe("synthetic-key-001");
    expect(headerOf(first)).toBeUndefined();
    expect(headerOf(second)).toBe("ids:41");
  });

  it("cancelling a first-send review retires it (nothing can still land); a later collection uses a new key", async () => {
    const keys = ["k-first-0001", "k-second-002"];
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(similar()).mockResolvedValueOnce(similar());
    const store = new MoneyAttemptStore(transport, () => keys.shift()!);
    await store.run("a", payment);
    expect(store.dismiss("a")).toBe("retired");
    expect(store.get("a")).toBeNull();
    await store.run("a", payment);
    expect(store.get("a")?.key).toBe("k-second-002");
  });

  it("after a lost reply, a review answer cannot prove the earlier send failed: cancel keeps the attempt uncertain", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("lost reply")).mockResolvedValueOnce(similar());
    const store = new MoneyAttemptStore(transport, () => "k-lost-00001");
    expect((await store.run("a", payment)).kind).toBe("uncertain");
    expect((await store.run("a")).kind).toBe("similar");
    expect(store.get("a")?.similar?.proven).toBe(false);
    expect(store.dismiss("a")).toBe("kept");
    expect(store.get("a")).toMatchObject({ phase: "uncertain", key: "k-lost-00001" });
  });

  it("a review is not a refusal: a different form cannot replace it, and a 409 without a valid list stays uncertain", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(similar())
      .mockResolvedValueOnce(Response.json({ reason: "similar_collection_review_required", message: "x" }, { status: 409 }));
    const store = new MoneyAttemptStore(transport, () => "k-review-001");
    await store.run("a", payment);
    const edited = { ...payment, body: payment.body.replace("500", "600") };
    expect((await store.run("a", edited)).kind).toBe("blocked");
    expect((await store.run("a", undefined, { observedReceiptIds: [41] })).kind).toBe("uncertain");
    expect(store.get("a")?.phase).toBe("uncertain");
  });
});
