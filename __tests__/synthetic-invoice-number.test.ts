import { describe, expect, it } from "vitest";
import { parseSyntheticInvoiceNumber } from "./security-http/synthetic-invoice-number";

describe("synthetic invoice number contract", () => {
  it.each([
    ["minimum padded", "INV-00001", "INV"],
    ["five digits", "INV-99999", "INV"],
    ["six digits", "FAC-100000", "FAC"],
    ["above safe integer", "FAC-9007199254740993", "FAC"],
  ] as const)("accepts %s", (_name, value, prefix) => {
    expect(parseSyntheticInvoiceNumber(value, prefix) !== null).toBe(true);
  });

  it.each([
    ["four digits", "INV-0042"],
    ["extra zero below five digits", "INV-000042"],
    ["extra zero above five digits", "INV-0100000"],
    ["zero", "INV-00000"],
    ["signed", "INV-+00042"],
    ["space", "INV-00042 "],
    ["newline", "INV-00042\n"],
    ["letters", "INV-00A42"],
    ["wrong prefix", "FAC-00042"],
    ["empty digits", "INV-"],
  ])("rejects %s", (_name, value) => {
    expect(parseSyntheticInvoiceNumber(value, "INV") === null).toBe(true);
  });

  it.each([
    ["width boundary", "INV-99999", "FAC-100000"],
    ["above safe integer", "INV-9007199254740992", "FAC-9007199254740993"],
  ])("checks one-step progression at %s without precision loss", (_name, before, after) => {
    const previous = parseSyntheticInvoiceNumber(before, "INV");
    const next = parseSyntheticInvoiceNumber(after, "FAC");
    expect(previous !== null && next !== null && next === previous + 1n).toBe(true);
  });

  it("rejects a skipped value above the safe integer limit", () => {
    const previous = parseSyntheticInvoiceNumber("INV-9007199254740992", "INV");
    const next = parseSyntheticInvoiceNumber("FAC-9007199254740994", "FAC");
    expect(previous !== null && next !== null && next === previous + 1n).toBe(false);
  });
});
