import { describe, expect, it } from "vitest";
import { invoiceNumberDiagnostic, invoiceStatusDiagnostic, makeInvoiceDiagnosticEmitter } from "./security-http/invoice-number-diagnostic";

describe("synthetic invoice number diagnostics", () => {
  it.each([
    ["INV-00042", "prefix=INV digits=five"],
    ["FAC-100000", "prefix=FAC digits=other"],
    ["OTHER-4321", "prefix=other digits=other"],
    ["INV-" + "9".repeat(100_000), "prefix=INV digits=other"],
    ["INV-1\n::error::synthetic-secret", "prefix=other digits=invalid"],
    [undefined, "prefix=other digits=invalid"],
  ])("emits only an allowlisted category and digit count", (input, expected) => {
    expect(invoiceNumberDiagnostic(input)).toBe(expected);
  });

  it.each([
    ...[201, 400, 401, 403, 404, 409, 413, 429].map((status) => [status, String(status)]),
    [500, "5xx"], [599, "5xx"], [499, "other"], [600, "other"], [500.1, "other"],
    ["201\n::error::synthetic-secret", "other"],
  ])("emits only an allowlisted status class", (input, expected) => {
    expect(invoiceStatusDiagnostic(input)).toBe(expected);
  });

  it("bounds notices and keeps injected stage and values out of the output", () => {
    const lines: string[] = [];
    const emit = makeInvoiceDiagnosticEmitter((line) => lines.push(line));
    for (let i = 0; i < 7; i += 1) emit("before\n::error::synthetic-secret", "number", "INV-1\n::error::synthetic-secret");
    expect(lines).toHaveLength(6);
    expect(new Set(lines)).toEqual(new Set(["::notice title=Synthetic invoice diagnostic::other prefix=other digits=invalid\n"]));
  });
});
