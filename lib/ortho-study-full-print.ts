import { journeyContentHash } from './ortho-case-journey-hash';
import { checkedStudyPageNotes } from './ortho-study-model-analysis-evidence';
import { FULL_STUDY_BODY, FULL_STUDY_LIMITS, fullStudyPageNotes, fullStudyTablePages, fullStudyWrap, validateFullStudyPresentation,
  type FullStudyPresentation, type FullStudyPage, type FullStudyTable } from './ortho-study-full-layout';

/** A browser-print profile, not a replacement for the immutable PPTX contract.
 * Physical dimensions are mm; source layout dimensions remain inches. */
export const FULL_STUDY_PRINT = Object.freeze({ renderer: 'ortho-full-print-v1', paperWidth: 297, paperHeight: 210,
  margin: 10, width: 254, height: 190, headerHeight: 44, metaTop: 44, metaHeight: 7,
  bodyTop: 51, bodyHeight: 112, footerTop: 165, footerHeight: 25, bodyWidth: FULL_STUDY_BODY.w * 25.4,
  sheets: 300, payloadBytes: 40 * 1024 * 1024 });
export const FULL_STUDY_PRINT_CONTRACT = journeyContentHash(FULL_STUDY_PRINT);
export interface PrintSourceFragment {
  sourceElementIndex: number; sourceRowIndex: number; sourceFragment: FullStudyTable['fragments'][number];
  printFragmentIndex: number; printFragmentCount: number;
}
export type FullPrintElement =
  | { kind: 'text'; text: string; sourceElementIndex: number; sourceLineStart: number; sourceLineEnd: number }
  | { kind: 'image'; sourceElementIndex: number; useId: string; sourceSha256: string; renditionSha256: string;
      dataUrl: string; width: number; height: number; x: number; y: number; w: number; h: number }
  | { kind: 'table'; sourceElementIndex: number; headers: string[]; rows: string[][]; columnWidths: number[];
      rowHeights: number[]; headerHeight: number; captionHeight: number; caption: string; fragments: PrintSourceFragment[]; continuationLabels: (string | null)[] };
export interface FullStudyPrintSheet {
  sourcePageIndex: number; title: string; panelId: string | null; purpose: FullStudyPage['purpose'];
  sourceKeys: string[]; modelUnapproved: boolean; continuation: number; continuationCount: number;
  elements: FullPrintElement[];
}
/** Safe view DTO: intentionally excludes raw capture, original image/use recipes,
 * model input/witness JSON and current patient identity. */
export interface FullStudyPrintPresentation {
  renderer: typeof FULL_STUDY_PRINT.renderer; contractHash: string; sourceProjectionHash: string;
  revisionId: number; revisionHash: string; caseId: number; version: number; kind: 'draft' | 'documented';
  capturedAt: string; sheets: FullStudyPrintSheet[]; notesBytes: number; payloadBytes: number; presentationHash: string;
}
const mm = (inches: number) => inches * 25.4;
const lineMm = 14 * 1.5 * 25.4 / 72;
function fail(code: string): never { throw Error(`study_full_print_${code}`); }
function contentForHash(value: FullStudyPrintPresentation) {
  const { presentationHash: _hash, payloadBytes: _bytes, ...content } = value; return content;
}
function serializedBytes(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
export function validateFullStudyPrint(value: FullStudyPrintPresentation): void {
  if (value.renderer !== FULL_STUDY_PRINT.renderer || value.contractHash !== FULL_STUDY_PRINT_CONTRACT
    || !value.sheets.length || value.sheets.length > FULL_STUDY_PRINT.sheets
    || value.notesBytes > FULL_STUDY_LIMITS.notesBytes || value.payloadBytes > FULL_STUDY_PRINT.payloadBytes
    || serializedBytes(contentForHash(value)) !== value.payloadBytes
    || journeyContentHash(contentForHash(value)) !== value.presentationHash) fail('contract');
}
/** Pure, synchronous snapshot of an already authorized/full-validated projection.
 * Keep preparation inside withIllustratedStudy so final authorization follows it. */
export function prepareFullStudyPrint(input: FullStudyPresentation): FullStudyPrintPresentation {
  const full = structuredClone(input); validateFullStudyPresentation(full);
  const sheets: FullStudyPrintSheet[] = [];
  const body = { x: 0, y: 0, w: FULL_STUDY_BODY.w, h: FULL_STUDY_PRINT.bodyHeight / 25.4 };
  for (const [sourcePageIndex, page] of full.pages.entries()) {
    const first = sheets.length;
    const add = (elements: FullPrintElement[], provenance = false) => {
      sheets.push({ sourcePageIndex, title: provenance ? `${page.title} — بصمات الصور المحفوظة` : page.title, panelId: page.panelId, purpose: provenance ? 'image-provenance' : page.purpose,
        sourceKeys: [...page.sourceKeys], modelUnapproved: !!page.modelAnalysisId, continuation: 0, continuationCount: 0, elements });
      if (sheets.length > FULL_STUDY_PRINT.sheets) fail('sheet_limit');
    };
    let text: FullPrintElement[] = [], used = 0;
    const flush = () => { if (text.length) add(text); text = []; used = 0; };
    for (let sourceElementIndex = 0; sourceElementIndex < page.elements.length; sourceElementIndex++) {
      const element = page.elements[sourceElementIndex];
      if (element.kind === 'text') {
        const lines = fullStudyWrap(element.text, body.w, element.fontSize), perSheet = Math.floor(FULL_STUDY_PRINT.bodyHeight / lineMm);
        if (lines.length <= perSheet && used + lines.length > perSheet) flush();
        for (let offset = 0; offset < lines.length;) {
          if (used === perSheet) flush();
          const end = Math.min(lines.length, offset + perSheet - used);
          text.push({ kind: 'text', text: lines.slice(offset, end).join('\n'), sourceElementIndex, sourceLineStart: offset, sourceLineEnd: end });
          used += end - offset; offset = end;
        }
      } else if (element.kind === 'table') {
        flush();
        // Existing pagination preserves the already recorded wrapped cell strings.
        // Child fragments point back to their exact parent row/field/fragment.
        const pages = fullStudyTablePages(element.headers, element.rows, body, element.sourceKeys, element.columnWidths);
        pages.forEach((part, index) => {
          if (part.projection === 'row_fields') fail('unexpected_table_reprojection');
          add([{ kind: 'table', sourceElementIndex, headers: part.headers, rows: part.rows,
            columnWidths: part.columnWidths.map(mm), rowHeights: part.rowHeights.map(mm), headerHeight: mm(part.headerHeight), captionHeight: mm(part.captionHeight),
            caption: `${element.caption} • استمرار الطباعة ${index + 1} من ${pages.length}`,
            continuationLabels: part.fragments.map((fragment, row) => element.projection === 'row_fields' && fragment.fragmentIndex > 0 && !part.rows[row][0] ? element.rows[fragment.rowIndex][0] : null),
            fragments: part.fragments.map(fragment => ({ sourceElementIndex, sourceRowIndex: fragment.rowIndex,
              sourceFragment: structuredClone(element.fragments[fragment.rowIndex]), printFragmentIndex: fragment.fragmentIndex, printFragmentCount: fragment.fragmentCount })) }]);
        });
      } else {
        flush();
        const images: FullPrintElement[] = [], scale = Math.min(FULL_STUDY_PRINT.bodyHeight / mm(FULL_STUDY_BODY.h), 1);
        // Consecutive source images remain a collage. Only display coordinates
        // change; the exact approved crop pixels and aspect ratio remain intact.
        while (sourceElementIndex < page.elements.length && page.elements[sourceElementIndex].kind === 'image') {
          const item = page.elements[sourceElementIndex]; if (item.kind !== 'image') break;
          images.push({ kind: 'image', sourceElementIndex, useId: item.image.use.useId,
            sourceSha256: item.image.sourceSha256, renditionSha256: item.image.renditionSha256,
            dataUrl: `data:image/png;base64,${Buffer.from(item.image.png).toString('base64')}`, width: item.image.frame.width, height: item.image.frame.height,
            x: (FULL_STUDY_PRINT.bodyWidth - mm(FULL_STUDY_BODY.w) * scale) / 2 + mm(item.rect.x - FULL_STUDY_BODY.x) * scale,
            y: mm(item.rect.y - FULL_STUDY_BODY.y) * scale, w: mm(item.rect.w) * scale, h: mm(item.rect.h) * scale });
          sourceElementIndex++;
        }
        sourceElementIndex--; add(images);
        // The previous print path exposed exact source/rendition hashes in its
        // footer. Preserve them visibly on bounded proof sheets, not hidden DOM.
        let proof: FullPrintElement[] = [];
        const maximum = Math.floor(FULL_STUDY_PRINT.bodyHeight / lineMm);
        for (const image of images) {
          if (image.kind !== 'image') continue;
          for (const line of [`الصورة المحفوظة: ${image.useId}`, `Source SHA256: ${image.sourceSha256}`, `Render SHA256: ${image.renditionSha256}`]) {
            if (proof.length === maximum) { add(proof, true); proof = []; }
            proof.push({ kind: 'text', text: line, sourceElementIndex: image.sourceElementIndex, sourceLineStart: 0, sourceLineEnd: 1 });
          }
        }
        if (proof.length) add(proof, true);
      }
    }
    flush();
    if (first === sheets.length) fail('empty_source_page');
    for (let index = first; index < sheets.length; index++) { sheets[index].continuation = index - first + 1; sheets[index].continuationCount = sheets.length - first; }
  }
  // Account for duplication by each derived sheet, although exact private notes
  // are deliberately not sent to browser DOM (PDF has no speaker-notes channel).
  const notes = checkedStudyPageNotes(sheets.map(sheet => fullStudyPageNotes(full, full.pages[sheet.sourcePageIndex])));
  const value: FullStudyPrintPresentation = { renderer: FULL_STUDY_PRINT.renderer, contractHash: FULL_STUDY_PRINT_CONTRACT,
    sourceProjectionHash: full.projectionHash, revisionId: full.revisionId, revisionHash: full.revisionHash, caseId: full.caseId,
    version: full.version, kind: full.kind, capturedAt: full.capturedAt, sheets,
    notesBytes: notes.reduce((sum, note) => sum + new TextEncoder().encode(note).byteLength, 0), payloadBytes: 0, presentationHash: '' };
  value.payloadBytes = serializedBytes(contentForHash(value));
  if (value.payloadBytes > FULL_STUDY_PRINT.payloadBytes) fail('payload_limit');
  value.presentationHash = journeyContentHash(contentForHash(value)); validateFullStudyPrint(value); return value;
}
