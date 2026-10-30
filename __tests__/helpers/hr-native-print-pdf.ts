import { assertPrintPdfHeader, type PrintPdfPage } from "./print-pdf-glyphs";

/** Native physical-sheet guard. Do not infer success from only the surviving
 * words: the full clinic heading also catches text clipped out of extraction. */
export function assertHrNativePdf(pages: PrintPdfPage[], expected: {
  landscape: boolean; short: boolean; clinicName: string;
}): void {
  if (expected.short ? pages.length !== 1 : pages.length < 2) {
    throw new Error(expected.short ? "Short HR document has a trailing or missing page" : "Long HR document did not paginate naturally");
  }
  const width = (expected.landscape ? 297 : 210) * 72 / 25.4;
  const height = (expected.landscape ? 210 : 297) * 72 / 25.4;
  for (const sheet of pages) {
    if (![sheet.width, sheet.height].every(Number.isFinite) || Math.abs(sheet.width - width) >= 1 || Math.abs(sheet.height - height) >= 1) {
      throw new Error("HR document lost its native A4 orientation");
    }
    if (!sheet.words.some(word => /\p{L}/u.test(word.text))) throw new Error("HR page has only decoration or margin counters");
    for (const word of sheet.words) {
      if (![word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)
        || word.xMin < 0 || word.yMin < 0 || word.xMax > sheet.width || word.yMax > sheet.height
        || word.xMin >= word.xMax || word.yMin >= word.yMax) {
        throw new Error("HR glyph escapes its physical page");
      }
    }
  }
  assertPrintPdfHeader(pages[0], expected.clinicName);
}
