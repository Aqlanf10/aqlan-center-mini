import { describe, expect, it } from "vitest";
import {
  projectReceiptProvenance, receiptDocumentTitle, receiptProvenanceFor,
  type ReceiptProvenanceAudit, type ReceiptProvenancePayment,
} from "../lib/receipt-provenance";

const AT = "2026-10-08T10:00:00.000Z";
const row = (id: number, extra: Partial<ReceiptProvenancePayment> = {}): ReceiptProvenancePayment => ({
  id: String(id), receiptNumber: `SYN-R-${id}`, patientId: "10", kind: "payment", amountMinor: "50000",
  currency: "YER", reversalOfId: null, createdBy: "synthetic-admin", createdAt: AT, ...extra,
});
const audit = (extra: Partial<ReceiptProvenanceAudit> = {}): ReceiptProvenanceAudit => ({
  id: "91", action: "payment.correct", entity: "payment", entityId: "1", actor: "synthetic-admin", createdAt: AT,
  details: { الطريقة: "تصحيح", السبب: "Synthetic reason private to the audit", المريض: 10,
    سند_العكس: "SYN-R-2", المبلغ_المعكوس: 50000, العملة_المعكوسة: "YER",
    السند_الصحيح: "SYN-R-3", المبلغ_الصحيح: 5000, العملة_الصحيحة: "YER" }, ...extra,
});
const rows = () => [row(1), row(2, { kind: "refund", reversalOfId: "1" }), row(3, { amountMinor: "5000" })];
const details = (extra: Record<string, unknown>): ReceiptProvenanceAudit => audit({
  details: { ...(audit().details as Record<string, unknown>), ...extra },
});

describe("receipt provenance is bounded evidence for display, never a financial mutation", () => {
  it("preserves original, reversal and replacement identities without exposing audit data", () => {
    const projected = projectReceiptProvenance([1, 2, 3], rows(), [audit()]);
    expect(projected[1].reversal).toEqual({ state: "full", reversedMinor: 50000, remainingMinor: 0 });
    expect(projected[1].correction).toEqual({ mode: "correct", reversal: { id: 2, receiptNumber: "SYN-R-2" },
      replacement: { id: 3, receiptNumber: "SYN-R-3" } });
    expect(projected[2].correctionReversal).toEqual({ mode: "correct", original: { id: 1, receiptNumber: "SYN-R-1" } });
    expect(projected[3].replacementOf).toEqual({ id: 1, receiptNumber: "SYN-R-1" });
    expect(JSON.stringify(projected)).not.toMatch(/Synthetic reason|synthetic-admin|actor|details|createdAt/);
    expect(receiptDocumentTitle("refund", projected[2])).toBe("قيد عكس لتصحيح سند");
    expect(receiptDocumentTitle("payment", projected[1])).toBe("سند قبض");
  });
  it("void records only reversal of the remaining original, after an ordinary partial refund", () => {
    const input = [row(1), row(2, { kind: "refund", reversalOfId: "1", amountMinor: "40000" }),
      row(4, { kind: "refund", reversalOfId: "1", amountMinor: "10000" })];
    const proof = details({ الطريقة: "إبطال", المبلغ_المعكوس: 40000,
      السند_الصحيح: null, المبلغ_الصحيح: null, العملة_الصحيحة: null });
    const p = projectReceiptProvenance([1, 2, 4], input, [proof]);
    expect(p[1].reversal).toMatchObject({ state: "full", reversedMinor: 50000 });
    expect(p[2].correctionReversal?.mode).toBe("void");
    expect(p[4].correctionReversal).toBeNull();
    expect(p[4].reversalOf?.id).toBe(1);
    expect(receiptDocumentTitle("refund", p[2])).toBe("قيد إبطال سند");
    expect(receiptDocumentTitle("refund", p[4])).toBe("سند عكس مرتبط");
  });
  it("a structural partial/full reversal without an audit never proves correction", () => {
    const partial = projectReceiptProvenance([1, 2], [row(1), row(2, { kind: "refund", reversalOfId: "1", amountMinor: "10000" })], []);
    expect(partial[1].reversal).toEqual({ state: "partial", reversedMinor: 10000, remainingMinor: 40000 });
    expect(partial[1].correction).toBeNull();
    expect(partial[2].correctionReversal).toBeNull();
    const full = projectReceiptProvenance([1, 2, 3], rows(), []);
    expect(full[1].reversal?.state).toBe("full");
    expect(full[1].correction).toBeNull();
    expect(full[3].replacementOf).toBeNull();
  });
  it("allows a corrected replacement to retain both incoming and outgoing provenance", () => {
    const input = [...rows(), row(4, { kind: "refund", reversalOfId: "3", amountMinor: "5000" }), row(5, { amountMinor: "3000" })];
    const later = audit({ id: "92", entityId: "3", details: { ...(audit().details as Record<string, unknown>),
      سند_العكس: "SYN-R-4", المبلغ_المعكوس: 5000, السند_الصحيح: "SYN-R-5", المبلغ_الصحيح: 3000 } });
    const p = projectReceiptProvenance([3], input, [audit(), later]);
    expect(p[3].replacementOf?.id).toBe(1);
    expect(p[3].correction?.replacement?.id).toBe(5);
    expect(p[3].reversal?.state).toBe("full");
    expect(Object.keys(p)).toEqual(["3"]);
  });
  it("permits a replacement currency to differ while the reversal retains original currency", () => {
    const input = rows(); input[2] = row(3, { amountMinor: "5000", currency: "SAR" });
    const p = projectReceiptProvenance([1, 2, 3], input, [details({ العملة_الصحيحة: "SAR" })]);
    expect(p[1].correction?.replacement?.id).toBe(3);
    expect(p[2].correctionReversal?.original.id).toBe(1);
  });
  it("recognizes the audit sanitizer's canonical long-reason truncation without exposing the reason", () => {
    const reason = "r".repeat(300) + "…";
    const p = projectReceiptProvenance([1, 2, 3], rows(), [details({ السبب: reason })]);
    expect(p[1].correction?.replacement?.id).toBe(3);
    expect(JSON.stringify(p)).not.toContain(reason);
    expect(projectReceiptProvenance([1], rows(), [details({ السبب: "r".repeat(301) })])[1].correction).toBeNull();
  });
  it.each([
    { المريض: "10" }, { المريض: 11 }, { الطريقة: "refund" }, { السبب: "" }, { المبلغ_المعكوس: "50000" },
    { المبلغ_المعكوس: 49999 }, { المبلغ_الصحيح: 0 }, { المبلغ_الصحيح: Number.MAX_SAFE_INTEGER + 1 },
    { العملة_المعكوسة: "USD" }, { العملة_الصحيحة: "EUR" }, { سند_العكس: "missing" },
    { السند_الصحيح: "SYN-R-1" }, { الطريقة: "إبطال" },
  ])("rejects malformed or contradictory structured audit %j", (changed) => {
    const p = projectReceiptProvenance([1, 2, 3], rows(), [details(changed)]);
    expect(p[1].correction).toBeNull();
    expect(p[1].correctionUnverified).toBe(true);
    expect(p[1].reversal?.state).toBe("full");
    expect(p[2].correctionReversal).toBeNull();
    expect(p[3].replacementOf).toBeNull();
  });
  it.each([
    { id: "not-an-id" }, { actor: "different" }, { createdAt: "2026-10-09T10:00:00.000Z" }, { details: [] }, { details: null },
  ])("rejects invalid audit envelope %j without throwing", (changed) => {
    const p = projectReceiptProvenance([1, 2, 3], rows(), [audit(changed)]);
    expect(p[1].correction).toBeNull(); expect(p[1].correctionUnverified).toBe(true);
  });
  it("rejects duplicate/competing audits instead of choosing the newest", () => {
    const p = projectReceiptProvenance([1, 2, 3], rows(), [audit(), audit({ id: "92" })]);
    expect(p[1].correction).toBeNull(); expect(p[2].correctionReversal).toBeNull(); expect(p[3].replacementOf).toBeNull();
    expect(p[1].reversal?.state).toBe("full");
  });
  it("rejects a cyclic replacement graph but retains separately proved reversals", () => {
    const input = [...rows(), row(4, { kind: "refund", reversalOfId: "3", amountMinor: "5000" })];
    const cyclic = audit({ id: "92", entityId: "3", details: { ...(audit().details as Record<string, unknown>),
      سند_العكس: "SYN-R-4", المبلغ_المعكوس: 5000, السند_الصحيح: "SYN-R-1", المبلغ_الصحيح: 50000 } });
    const p = projectReceiptProvenance([1, 2, 3, 4], input, [audit(), cyclic]);
    for (const item of Object.values(p)) {
      expect(item.correction).toBeNull(); expect(item.replacementOf).toBeNull(); expect(item.correctionReversal).toBeNull();
    }
    expect(p[1].reversal?.state).toBe("full"); expect(p[3].reversal?.state).toBe("full");
  });
  it("never exposes another patient's reference or invents totals from corrupt links", () => {
    const input = rows(); input[1] = row(2, { patientId: "11", kind: "refund", reversalOfId: "1" });
    const p = projectReceiptProvenance([1, 2], input, [audit()]);
    expect(p[1].reversal?.state).toBe("unverified"); expect(p[1].correction).toBeNull();
    expect(p[2].reversalOf).toBeNull(); expect(p[2].correctionReversal).toBeNull();
  });
  it.each([
    { amountMinor: "9007199254740992" }, { amountMinor: "-1" }, { amountMinor: "0" },
    { amountMinor: "50001" }, { currency: "SAR" }, { currency: "EUR" }, { kind: "payment" },
  ])("invalid linked reversal cannot look unreversed or fully reversed: %j", (changed) => {
    const input = [row(1), row(2, { kind: "refund", reversalOfId: "1", ...changed })];
    const p = projectReceiptProvenance([1], input, []);
    expect(p[1].reversal).toEqual({ state: "unverified", reversedMinor: null, remainingMinor: null });
  });
  it("incomplete payment context is unavailable; incomplete audit retains structural truth only", () => {
    const incomplete = projectReceiptProvenance([1, 2, 3], rows(), [audit()], { payments: false, audits: true });
    for (const p of Object.values(incomplete)) { expect(p.status).toBe("unavailable"); expect(p.reversal).toBeNull(); }
    const structural = projectReceiptProvenance([1, 2, 3], rows(), [audit()], { payments: true, audits: false });
    expect(structural[1].reversal?.state).toBe("full");
    expect(structural[1].correction).toBeNull(); expect(structural[3].replacementOf).toBeNull();
    expect(structural[1].correctionUnverified).toBe(true);
  });
  it("wire validation never upgrades absent/malformed evidence to ordinary financial truth", () => {
    const p = projectReceiptProvenance([1, 2, 3], rows(), [audit()]);
    expect(receiptProvenanceFor(undefined, 1, 50000, "payment")).toBeUndefined();
    expect(receiptProvenanceFor(p, 1, 50000, "payment")).toEqual(p[1]);
    expect(receiptProvenanceFor(p, 1, 40000, "payment")?.status).toBe("unavailable");
    for (const bad of [null, [], {}, { 1: null }, { 1: { ...p[1], reversal: { state: "full", reversedMinor: 50000, remainingMinor: 1 } } },
      { 1: { ...p[1], correction: { mode: "correct", reversal: { id: "2", receiptNumber: "x" }, replacement: null } } }]) {
      expect(receiptProvenanceFor(bad, 1, 50000, "payment")?.status).toBe("unavailable");
    }
    expect(receiptDocumentTitle("refund")).toBe("سند عكس");
  });
  it("wire references cannot self-link, contradict document kind or disagree on receipt identity", () => {
    const p = projectReceiptProvenance([1, 2, 3], rows(), [audit()]);
    expect(receiptProvenanceFor(p, 1, 50000, "refund")?.status).toBe("unavailable");
    expect(receiptProvenanceFor(p, 2, 50000, "payment")?.status).toBe("unavailable");
    expect(receiptProvenanceFor({ 3: { ...p[3], replacementOf: { id: 3, receiptNumber: "SYN-R-3" } } }, 3, 5000, "payment")?.status)
      .toBe("unavailable");
    expect(receiptProvenanceFor({ 2: { ...p[2], reversalOf: { id: 1, receiptNumber: "WRONG" } } }, 2, 50000, "refund")?.status)
      .toBe("unavailable");
    expect(receiptProvenanceFor({ 1: { ...p[1], correction: { ...p[1].correction, replacement: p[1].correction!.reversal } } },
      1, 50000, "payment")?.status).toBe("unavailable");
    for (const replacementOf of [p[1].correction!.reversal, p[1].correction!.replacement]) {
      expect(receiptProvenanceFor({ 1: { ...p[1], replacementOf } }, 1, 50000, "payment")?.status).toBe("unavailable");
    }
    expect(receiptProvenanceFor({ 3: { ...p[3], replacementOf: { id: 1, receiptNumber: "SYN-R-3" } } },
      3, 5000, "payment", "SYN-R-3")?.status).toBe("unavailable");
  });
});
