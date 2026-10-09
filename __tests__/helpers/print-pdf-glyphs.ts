export interface PrintPdfWord {
  text: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}
export interface PrintPdfPage { width: number; height: number; words: PrintPdfWord[] }

const plain = (text: string) => text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
const compact = (text: string) => plain(text).replace(/\s+/g, "");

/**
 * Calibrated against the actual failed Chromium PDF, not a permissive character
 * bag: bbox نلاقع renders عقلان. Poppler preserved the lam-alef glyph's logical
 * pair while ordering surrounding glyphs visually. Keep each such pair intact
 * when reversing the expected glyph run; every other character retains order.
 */
export function matchesPrintPdfWord(actual: string, expected: string): boolean {
  const value = compact(actual), logical = compact(expected);
  if (value === logical) return true;
  if (!/[\u0600-\u06ff]/.test(logical)) return false;
  const glyphs = logical.match(/\u0644[\u0622\u0623\u0625\u0627]|[\s\S]/gu) ?? [];
  return value === [...logical].reverse().join("") || value === glyphs.reverse().join("");
}

/** First-page clinic header only, in native top-to-bottom/RTL reading order. */
export function assertPrintPdfHeader(page: PrintPdfPage, expectedText: string): void {
  const bottom = Math.min(180, page.height / 2);
  const words = page.words.filter(word => word.yMin >= 0 && word.yMax <= bottom
    && word.xMin >= 0 && word.xMax <= page.width && /\p{L}/u.test(word.text));
  const lines: { top: number; words: PrintPdfWord[] }[] = [];
  for (const word of [...words].sort((a, b) => a.yMin - b.yMin)) {
    const line = lines.find(candidate => Math.abs(candidate.top - word.yMin) <= 2);
    if (line) line.words.push(word); else lines.push({ top: word.yMin, words: [word] });
  }
  const ordered = lines.flatMap(line => line.words.sort((a, b) => b.xMin - a.xMin));
  const expected = expectedText.split(/\s+/).filter(word => /\p{L}/u.test(word));
  if (expected.length === 0) throw new Error("PDF header has no expected words");
  for (const [index, word] of expected.entries()) {
    if (!ordered[index] || !matchesPrintPdfWord(ordered[index].text, word)) {
      throw new Error(`PDF header ordered glyph mismatch at ${index}: ${word} / ${ordered[index]?.text ?? "missing"}`);
    }
  }
}

/** Colon/dot bidi extraction is checked as native words on one bounded signature row. */
export function assertPrintPdfSignature(page: PrintPdfPage, expectedText: string): void {
  const expected = expectedText.split(/\s+/).filter(word => /\p{L}/u.test(word));
  if (expected.length === 0) throw new Error("PDF signature has no expected words");
  const words = page.words.filter(word => word.yMin >= page.height * 0.25 && word.yMax <= page.height * 0.9
    && word.yMax - word.yMin <= 16 && word.xMin >= 0 && word.xMax <= page.width && /\p{L}/u.test(word.text));
  const anchors = words.filter(word => matchesPrintPdfWord(word.text, expected[0]));
  if (anchors.length !== 1) throw new Error("PDF signature row anchor missing or duplicated");
  const row = words.filter(word => Math.abs(word.yMin - anchors[0].yMin) <= 2).sort((a, b) => b.xMin - a.xMin);
  if (row.length !== expected.length || expected.some((word, index) => !matchesPrintPdfWord(row[index].text, word))) {
    throw new Error("PDF signature ordered row glyph mismatch");
  }
}

/**
 * The rotated 26pt watermark is fragmented by Poppler. Select only its central
 * paper region and large glyph boxes, then reconstruct in spatial RTL order.
 * Exact sequence, not whole-page character membership; hidden-control PDFs
 * exercise refusal independently from header/amount checks.
 */
export function assertPrintPdfWatermark(page: PrintPdfPage, expected: boolean): void {
  const fragments = page.words.filter(word => word.yMax - word.yMin >= 28
    && word.xMin >= page.width * 0.2 && word.xMax <= page.width * 0.8
    && word.yMin >= page.height * 0.3 && word.yMax <= page.height * 0.7)
    .sort((a, b) => (b.xMin + b.xMax) - (a.xMin + a.xMax));
  if (!expected) {
    if (fragments.length !== 0) throw new Error("PDF watermark must be absent");
    return;
  }
  const logical = "نسخةمعادطباعتها";
  const reversedFragments = fragments.map(word => [...compact(word.text)].reverse().join("")).join("");
  const directFragments = fragments.map(word => compact(word.text)).join("");
  if (reversedFragments !== logical && directFragments !== logical) {
    throw new Error(`PDF watermark ordered glyph mismatch: ${reversedFragments || "missing"}`);
  }
}

/**
 * Receipt-only calibration from CI37834754641's native A6 reversal PDF:
 * SHA-256 8acbb0ad010ea856084d66d69755f95947b4e9acd96d44b59f4610e031df7446.
 * Poppler splits سجّله: into RTL-adjacent جّس and :هل, 0.352173pt apart.
 * Decode only that exact marked label; keep the shared signature oracle intact.
 */
export function assertReceiptPrintPdfSignature(page: PrintPdfPage, expectedText: string): void {
  const expectedLabel = expectedText.split(/\s+/).find(word => /\p{L}/u.test(word));
  if (expectedLabel !== "سجّله:") return assertPrintPdfSignature(page, expectedText);

  // Preserve marks on their base glyph while reversing each native fragment.
  const reverseMarkedGlyphs = (text: string) =>
    (compact(text).match(/[^\p{M}]\p{M}*|\p{M}+/gu) ?? []).reverse().join("");
  const rightFragments = page.words.filter(word => compact(word.text) === "جّس");
  const leftFragments = page.words.filter(word => compact(word.text) === ":هل");
  const wholeLabels = page.words.filter(word => matchesPrintPdfWord(word.text, expectedLabel)
    || reverseMarkedGlyphs(word.text) === expectedLabel);
  // Count before region filtering so a second or displaced copy cannot hide.
  if (rightFragments.length !== 1 || leftFragments.length !== 1 || wholeLabels.length !== 0) {
    throw new Error("PDF signature receipt fragments missing or duplicated");
  }
  const right = rightFragments[0], left = leftFragments[0];
  const inRegion = (word: PrintPdfWord) =>
    [page.width, page.height, word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)
    && word.xMin >= 0 && word.xMin < word.xMax && word.xMax <= page.width
    && word.yMin >= page.height * 0.25 && word.yMin < word.yMax
    && word.yMax <= page.height * 0.9 && word.yMax - word.yMin <= 16;
  const gap = right.xMin - left.xMax;
  const merged: PrintPdfWord = {
    text: reverseMarkedGlyphs(right.text) + reverseMarkedGlyphs(left.text),
    xMin: left.xMin, xMax: right.xMax,
    yMin: Math.min(left.yMin, right.yMin), yMax: Math.max(left.yMax, right.yMax),
  };
  if (!inRegion(right) || !inRegion(left) || !inRegion(merged)
    || Math.abs(right.yMin - left.yMin) > 2 || gap < 0 || gap > 0.5
    || merged.text !== expectedLabel) {
    throw new Error("PDF signature receipt fragments violate exact glyph geometry");
  }
  // Neither input words nor their geometry change. The unchanged shared oracle
  // still requires a unique anchor and the complete, exact RTL signature row.
  assertPrintPdfSignature({ ...page,
    words: [...page.words.filter(word => word !== right && word !== left), merged],
  }, expectedText);
}
