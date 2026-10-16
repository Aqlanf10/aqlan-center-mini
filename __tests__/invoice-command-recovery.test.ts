import { describe, expect, it } from "vitest";
import { invoiceCommandForOwner, invoiceCommandOutcome, retainInvoiceCommand } from "../lib/invoice-command-recovery";

describe("template invoice exact-command recovery", () => {
  it("replays immutable original intent and key after caller data/catalogue changes", () => {
    const owner = {}, body = { idempotencyKey: "inv-original", templateSelection: { version: "a".repeat(64), teeth: [36] }, items: [] };
    const lease = retainInvoiceCommand(owner, body);
    body.templateSelection.version = "b".repeat(64); body.templateSelection.teeth.push(37);
    expect(invoiceCommandForOwner(lease, owner)).toEqual({ idempotencyKey: "inv-original", templateSelection: { version: "a".repeat(64), teeth: [36] }, items: [] });
    const first = invoiceCommandForOwner(lease, owner)!; first.idempotencyKey = "mutated";
    expect(invoiceCommandForOwner(lease, owner)?.idempotencyKey).toBe("inv-original");
  });
  it("cannot replay into a new owner or revived same-value owner", () => {
    const original = { patientId: 11 }, lease = retainInvoiceCommand(original, { idempotencyKey: "inv-original" });
    expect(invoiceCommandForOwner(lease, { patientId: 12 })).toBeNull();
    expect(invoiceCommandForOwner(lease, { patientId: 11 })).toBeNull();
  });
  it.each([0, 200, 201, 401, 403, 409, 500, 503])("retains unknown or unverified response %i", status => {
    expect(invoiceCommandOutcome(status, null, false)).toBe("uncertain");
  });
  it("only a verified exact receipt succeeds, and redirects never do", () => {
    expect(invoiceCommandOutcome(200, {}, true)).toBe("saved");
    expect(invoiceCommandOutcome(201, {}, true)).toBe("saved");
    expect(invoiceCommandOutcome(200, {}, true, true)).toBe("uncertain");
  });
  it("distinguishes explicit rolled-back busy and validation refusal without replacing a key", () => {
    expect(invoiceCommandOutcome(409, { code: "INVOICE_TEMPLATE_BUSY" }, false)).toBe("busy");
    expect(invoiceCommandOutcome(400, { code: "INVOICE_TEMPLATE_INVALID" }, false)).toBe("refused");
    expect(invoiceCommandOutcome(409, { code: "INVOICE_TEMPLATE_STALE" }, false)).toBe("refused");
    expect(invoiceCommandOutcome(409, { code: "INVOICE_TEMPLATE_REVIEW_REQUIRED" }, false)).toBe("refused");
    expect(invoiceCommandOutcome(500, { code: "INVOICE_TEMPLATE_STALE" }, false)).toBe("uncertain");
    expect(invoiceCommandOutcome(409, { code: { toString: () => "INVOICE_TEMPLATE_BUSY" } }, false)).toBe("uncertain");
  });
  it.each([400, 409])("allows confirmed editing after a bounded explicit refusal %i while retaining original recovery", status => {
    const owner = {}, original = retainInvoiceCommand(owner, { idempotencyKey: "inv-original", amountMinor: 300000 });
    expect(invoiceCommandOutcome(status, { message: "تعذّر اعتماد موضع العلاج" }, false)).toBe("refused");
    const edited = retainInvoiceCommand(owner, { idempotencyKey: "inv-original", amountMinor: 180000 });
    expect(invoiceCommandForOwner(original, owner)).toEqual({ idempotencyKey: "inv-original", amountMinor: 300000 });
    expect(invoiceCommandForOwner(edited, owner)).toEqual({ idempotencyKey: "inv-original", amountMinor: 180000 });
  });
  it("keeps denied, malformed, oversized and unknown errors uncertain", () => {
    for (const status of [401, 403, 500, 503]) {
      expect(invoiceCommandOutcome(status, { message: "رفض الطلب" }, false)).toBe("uncertain");
    }
    for (const message of [null, "", "   ", "x".repeat(1501), { toString: () => "رفض الطلب" }]) {
      expect(invoiceCommandOutcome(409, { message }, false)).toBe("uncertain");
    }
    expect(invoiceCommandOutcome(409, { message: "رفض الطلب" }, false, true)).toBe("uncertain");
  });
});
