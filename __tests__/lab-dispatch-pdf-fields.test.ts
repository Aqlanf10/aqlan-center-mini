import { describe, expect, it } from "vitest";
import { assertLabDispatchPdfFields, type LabDispatchPdfBlock, type LabDispatchPdfPage } from "./helpers/lab-dispatch-pdf-fields";
import type { PrintPdfWord } from "./helpers/print-pdf-glyphs";

const tail = "1791625080163";
const expected = { service: `SYNTHETIC-DISPATCH-SERVICE-${tail}`, lab: `SYNTHETIC-DISPATCH-LAB-A-${tail}`, labPhone: "777123456" };
const word = (text: string, xMin: number, yMin: number, width: number): PrintPdfWord => ({ text, xMin, xMax: xMin + width, yMin, yMax: yMin + 10 });
const block = (lines: PrintPdfWord[][]): LabDispatchPdfBlock => ({ lines,
  xMin: Math.min(...lines.flat().map(word => word.xMin)), xMax: Math.max(...lines.flat().map(word => word.xMax)),
  yMin: Math.min(...lines.flat().map(word => word.yMin)), yMax: Math.max(...lines.flat().map(word => word.yMax)),
});
function fixture(): LabDispatchPdfPage[] {
  // Native CI1800 topology: RTL label columns surround a two-line LTR service
  // identifier; lab label and authorized phone share the wrapped lab block.
  const blocks = [
    block([[word("SYNTHETIC-DISPATCH-SERVICE-", 264, 378, 160)], [word(tail, 352, 392, 72)]]),
    block([[word(":", 455, 384, 3), word("ةبيكرتلاو", 458, 384, 32), word("لمعلا", 493, 384, 22), word("عون", 518, 384, 12)]]),
    block([[word(":", 168, 384, 3), word("ةعبطلا", 172, 384, 24), word("عون", 199, 384, 12)]]),
    block([[word("SYNTHETIC-DISPATCH-LAB-", 158, 186, 143), word(":", 303, 186, 3), word("ربتخملا", 307, 186, 28)],
      [word("(777123456)", 197, 202, 45), word(`A-${tail}`, 248, 202, 87)]]),
  ];
  return [{ width: 596, height: 843, blocks, words: blocks.flatMap(block => block.lines.flat()) }];
}

describe("field-bounded lab dispatch PDF identifiers", () => {
  it("accepts complete RTL-wrapped fields despite neighboring column/phone interleaving", () => {
    expect(() => assertLabDispatchPdfFields(fixture(), expected)).not.toThrow();
  });
  it.each(["1791625080164", "179162508016", ""]) ("rejects wrong or missing service tail %j", tail => {
    const pages = fixture(); pages[0].blocks[0].lines[1][0].text = tail;
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
  it.each(["A-1791625080164", "A-179162508016", ""]) ("rejects wrong or missing lab tail %j", tail => {
    const pages = fixture(); pages[0].blocks[3].lines[1][1].text = tail;
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
  it("rejects a complete service identifier moved into the other table column", () => {
    const pages = fixture(), value = pages[0].blocks[0];
    for (const word of value.lines.flat()) { word.xMin -= 220; word.xMax -= 220; }
    pages[0].blocks[0] = block(value.lines);
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
  it("does not borrow a missing suffix from another block", () => {
    const pages = fixture(), value = pages[0].blocks[0];
    pages[0].blocks.push(block(value.lines.slice(1)));
    pages[0].blocks[0] = block(value.lines.slice(0, 1));
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
  it("rejects an identifier in a block without the correct lab label", () => {
    const pages = fixture(); pages[0].blocks[3].lines[0][2].text = "المريض";
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
  it("rejects extra PII or other unknown words inside the lab identifier field", () => {
    const pages = fixture(), value = pages[0].blocks[3];
    value.lines.push([word("SYNPRIVATEPATIENT123", 200, 217, 120)]);
    pages[0].blocks[3] = block(value.lines);
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
  it("rejects a duplicate complete service field instead of choosing the first", () => {
    const pages = fixture(); pages[0].blocks.push(structuredClone(pages[0].blocks[0]));
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
  it("rejects field glyphs clipped outside their block", () => {
    const pages = fixture(); pages[0].blocks[0].lines[1][0].xMax += 1;
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
  it("rejects overlapping identifier lines", () => {
    const pages = fixture(); pages[0].blocks[0].lines[1][0].yMin = 380;
    expect(() => assertLabDispatchPdfFields(pages, expected)).toThrow();
  });
});
