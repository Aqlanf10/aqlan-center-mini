import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { parseCanonicalOrthoDecision: parse } = await import("../lib/canonical-ortho-decision-command");
const body = { patientId: 2, expectedVersion: "a".repeat(64), decision: "no_charge", reason: " سبب مشروع ", invoiceNumber: null };
it("preserves exact documented no-charge and invoice-number branches without amount or owner fields", () => {
  expect(parse("1", body)).toEqual({ ...body, adjustmentId: 1, reason: "سبب مشروع" });
  expect(parse("1", { ...body, decision: "billed", reason: null, invoiceNumber: " INV-1 " })).toMatchObject({ decision: "billed", invoiceNumber: "INV-1" });
});
it.each([null, [], { ...body, patientId: "2" }, { ...body, patientId: 0 }, { ...body, expectedVersion: "x" }, { ...body, decision: ["no_charge"] }, { ...body, decision: {} }, { ...body, reason: " x " }, { ...body, reason: "ع".repeat(301) }, { ...body, reason: {} }, { ...body, invoiceNumber: "INV" }, { ...body, owner: true }, { ...body, amount: 0 }, { ...body, decision: "billed", reason: null, invoiceNumber: [] }, { ...body, decision: "billed", reason: null, invoiceNumber: " " }, { ...body, decision: "billed", invoiceNumber: "INV" }])("rejects malformed, coerced or branch-mixed input %#", value => { expect(() => parse("1", value)).toThrow(); });
it.each(["0", "-1", "1.1", "01", "1e0", "2147483648"])("refuses noncanonical adjustment id %s", id => { expect(() => parse(id, body)).toThrow(); });
