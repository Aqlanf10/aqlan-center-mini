import { matchesPrintPdfWord, type PrintPdfPage, type PrintPdfWord } from "./print-pdf-glyphs";

export interface LabDispatchPdfBlock {
  xMin: number; xMax: number; yMin: number; yMax: number;
  lines: PrintPdfWord[][];
}
export interface LabDispatchPdfPage extends PrintPdfPage { blocks: LabDispatchPdfBlock[] }

const compact = (text: string) => text.normalize("NFKC")
  .replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
const only = <T>(values: T[], description: string): T => {
  if (values.length !== 1) throw new Error(`PDF ${description} must occur in exactly one field block`);
  return values[0];
};

function visibleLines(page: LabDispatchPdfPage, block: LabDispatchPdfBlock): PrintPdfWord[][] {
  const box = [page.width, page.height, block.xMin, block.xMax, block.yMin, block.yMax];
  if (!box.every(Number.isFinite) || !(page.width > 0 && page.height > 0
    && block.xMin >= 0 && block.xMax <= page.width && block.xMin < block.xMax
    && block.yMin >= 0 && block.yMax <= page.height && block.yMin < block.yMax)) {
    throw new Error("PDF field block is outside its physical page");
  }
  if (block.lines.length === 0 || block.lines.some(line => line.length === 0)) throw new Error("PDF field block has an empty line");
  const lines = block.lines.map(line => [...line].sort((a, b) => a.xMin - b.xMin))
    .sort((a, b) => Math.min(...a.map(word => word.yMin)) - Math.min(...b.map(word => word.yMin)));
  for (const line of lines) {
    for (const [index, word] of line.entries()) {
      if (![word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)
        || word.xMin < block.xMin || word.xMax > block.xMax || word.xMin >= word.xMax
        || word.yMin < block.yMin || word.yMax > block.yMax || word.yMin >= word.yMax
        || (index > 0 && line[index - 1].xMax > word.xMin + 0.01)) {
        throw new Error("PDF field glyphs overlap or escape their block");
      }
    }
  }
  for (let index = 1; index < lines.length; index++) {
    const previousBottom = Math.max(...lines[index - 1].map(word => word.yMax));
    const nextTop = Math.min(...lines[index].map(word => word.yMin));
    const lineHeight = Math.max(...lines[index - 1].map(word => word.yMax - word.yMin));
    if (nextTop < previousBottom - 0.01 || nextTop - previousBottom > lineHeight * 2) {
      throw new Error("PDF field lines overlap or are not an adjacent wrapped field");
    }
  }
  return lines;
}

function labelEquals(block: LabDispatchPdfBlock, expected: string[]): boolean {
  if (block.lines.length !== 1) return false;
  const words = [...block.lines[0]].sort((a, b) => b.xMin - a.xMin);
  return words.length === expected.length && expected.every((word, index) => matchesPrintPdfWord(words[index].text, word));
}

/**
 * Calibrated against the retained native CI1800 PDF. Poppler's global -layout
 * stream interleaves other columns between wrapped identifier lines. Require
 * the complete ordered identifier in one physical, uniquely anchored field.
 * Never concatenate fragments from unrelated blocks or ignore unknown words.
 * This synthetic witness does not replace whole-PDF privacy/canary assertions.
 */
export function assertLabDispatchPdfFields(pages: LabDispatchPdfPage[], expected: {
  service: string; lab: string; labPhone: string;
}): void {
  const service = compact(expected.service), lab = compact(expected.lab);
  if (!/^SYNTHETIC-DISPATCH-SERVICE-[0-9]+$/.test(service)
    || !/^SYNTHETIC-DISPATCH-LAB-[AB]-[0-9]+$/.test(lab)
    || !/^[0-9]{9}$/.test(expected.labPhone)) throw new Error("Invalid synthetic PDF field expectation");
  const blocks = pages.flatMap(page => page.blocks.map(block => ({ page, block })));
  const serviceLabel = only(blocks.filter(({ block }) => labelEquals(block, ["نوع", "العمل", "والتركيبة", ":"])), "service label");
  const impressionLabel = only(blocks.filter(({ block }) => labelEquals(block, ["نوع", "الطبعة", ":"])), "impression label");
  visibleLines(serviceLabel.page, serviceLabel.block);
  visibleLines(impressionLabel.page, impressionLabel.block);
  const serviceField = only(blocks.filter(({ page, block }) => {
    if (page !== serviceLabel.page || page !== impressionLabel.page) return false;
    if (!(block.xMin > impressionLabel.block.xMax && block.xMax < serviceLabel.block.xMin
      && block.yMin <= serviceLabel.block.yMax && block.yMax >= serviceLabel.block.yMin
      && block.yMin <= impressionLabel.block.yMax && block.yMax >= impressionLabel.block.yMin)) return false;
    return visibleLines(page, block).flat().map(word => compact(word.text)).join("") === service;
  }), "complete service identifier in its labeled table cell");
  visibleLines(serviceField.page, serviceField.block);

  const labField = only(blocks.filter(({ block }) => block.lines.flat()
    .some(word => matchesPrintPdfWord(word.text, "المختبر"))), "lab label");
  const labLines = visibleLines(labField.page, labField.block);
  const label = labLines.flat().filter(word => matchesPrintPdfWord(word.text, "المختبر"));
  const colon = labLines.flat().filter(word => compact(word.text) === ":");
  const phone = labLines.flat().filter(word => compact(word.text) === `(${expected.labPhone})`);
  if (label.length !== 1 || colon.length !== 1 || phone.length !== 1) throw new Error("PDF lab field label/phone boundary changed");
  const ancillary = new Set([...label, ...colon, ...phone]);
  const identifier = labLines.flat().filter(word => !ancillary.has(word)).map(word => compact(word.text)).join("");
  if (identifier !== lab) throw new Error("PDF complete lab identifier mismatch inside labeled field");
}
