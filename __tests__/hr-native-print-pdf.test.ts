import { describe, expect, it } from "vitest";
import { assertHrNativePdf } from "./helpers/hr-native-print-pdf";
import type { PrintPdfPage } from "./helpers/print-pdf-glyphs";

const expected = { landscape: true, short: true, clinicName: "SYNTHETIC CLINIC" };
function page(): PrintPdfPage {
  return { width: 297 * 72 / 25.4, height: 210 * 72 / 25.4, words: [
    { text: "SYNTHETIC", xMin: 150, xMax: 220, yMin: 20, yMax: 30 },
    { text: "CLINIC", xMin: 80, xMax: 140, yMin: 20, yMax: 30 },
    { text: "HS001", xMin: 80, xMax: 120, yMin: 220, yMax: 230 },
  ] };
}
describe("native HR paper guard", () => {
  it("accepts a bounded complete short sheet and natural text continuation", () => {
    expect(() => assertHrNativePdf([page()], expected)).not.toThrow();
    expect(() => assertHrNativePdf([page(), page()], { ...expected, short: false })).not.toThrow();
  });
  it("rejects the trailing page of a short report", () => {
    expect(() => assertHrNativePdf([page(), page()], expected)).toThrow(/trailing/);
  });
  it("rejects a watermark-only continuation even when margin counters exist", () => {
    const blank = page(); blank.words = [{ text: "2/2", xMin: 100, xMax: 120, yMin: 550, yMax: 560 }];
    expect(() => assertHrNativePdf([page(), blank], { ...expected, short: false })).toThrow(/decoration/);
  });
  it("rejects lost orientation and unbounded glyphs", () => {
    const portrait = page(); [portrait.width, portrait.height] = [portrait.height, portrait.width];
    expect(() => assertHrNativePdf([portrait], expected)).toThrow(/orientation/);
    const overflow = page(); overflow.words[2].xMin = -1;
    expect(() => assertHrNativePdf([overflow], expected)).toThrow(/escapes/);
    const invalid = page(); invalid.words[2].yMax = Number.NaN;
    expect(() => assertHrNativePdf([invalid], expected)).toThrow(/escapes/);
    const zeroWidth = page(); zeroWidth.words[2].xMax = zeroWidth.words[2].xMin;
    expect(() => assertHrNativePdf([zeroWidth], expected)).toThrow(/escapes/);
    const reversedHeight = page(); reversedHeight.words[2].yMax = reversedHeight.words[2].yMin - 1;
    expect(() => assertHrNativePdf([reversedHeight], expected)).toThrow(/escapes/);
  });
  it("rejects a header word clipped completely out of PDF extraction", () => {
    const clipped = page(); clipped.words = clipped.words.slice(1);
    expect(() => assertHrNativePdf([clipped], expected)).toThrow(/header ordered glyph mismatch/);
  });
});
