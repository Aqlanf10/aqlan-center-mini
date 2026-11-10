import { CASE_LAYOUTS, CASE_PAGE, CASE_TEMPLATE_IDENTITY, caseLayout, type CaseRect } from './ortho-case-template';
import { journeyContentHash } from './ortho-case-journey-hash';
import { decodeStudySavedContent, type StudySavedContent } from './ortho-case-study-capture';
import { projectStudyRecordedFacts } from './ortho-case-study-recorded-facts';
import type { StudyRevision } from './ortho-case-study-history';
import type { JourneyScope } from './ortho-case-journey-records';
import { illustrateSavedStudy, type StudyIllustratedImage, type StudyIllustratedPresentation } from './ortho-study-illustrated';
import { studyTextPresentation, type StudyTextPage } from './ortho-study-text-export';
import { studySourceName } from './ortho-case-presentation-i18n';
import { wrapStudyTextLine } from './ortho-study-display';
import { canonicalOrthoMediaGeometryWitness, canonicalOrthoMediaRecipe } from './ortho-study-media';
import { STUDY_IMAGE_PROCESSOR } from './ortho-study-image-contract';
import { hashBytes, validateCasePng } from './ortho-case-render-security';

/** Presentation-only version: stored template geometry and capture hashes never change.
 * Caller must remain inside withIllustratedStudy's current authorization/final check.
 * This module has no database, file, URL, patient-name or branding input. */
export const FULL_STUDY_RENDERER = 'ortho-full-layout-pptx-v1';
export const FULL_STUDY_LIMITS = Object.freeze({ pages: 300, images: 40, imageBytes: 24 * 1024 * 1024,
  pngBytes: 4 * 1024 * 1024, text: 240_000, outputBytes: 24 * 1024 * 1024, rows: 4000 });
export const FULL_STUDY_BODY: Readonly<CaseRect> = Object.freeze({ x: .4, y: 1.1, w: 9.2, h: 5.75 });
const BODY_FONT = 14, TABLE_FONT = 12, PADDING = .10, TABLE_CAPTION_HEIGHT = .55, MIN_COLUMN_WIDTH = 1.1;
const lineHeight = (font: number) => font * 1.5 / 72;
const insetScale = FULL_STUDY_BODY.h / CASE_PAGE.height;
export const FULL_STUDY_CONTRACT_HASH = journeyContentHash({ renderer: FULL_STUDY_RENDERER,
  templateHash: journeyContentHash(CASE_TEMPLATE_IDENTITY), body: FULL_STUDY_BODY,
  uniformInsetScale: insetScale, bodyFont: BODY_FONT, tableFont: TABLE_FONT, tableCaptionHeight: TABLE_CAPTION_HEIGHT, minColumnWidth: MIN_COLUMN_WIDTH, wideTable: 'source_row_field_value', limits: FULL_STUDY_LIMITS });

export interface FullStudyText { kind: 'text'; rect: CaseRect; text: string; fontSize: number }
export interface FullStudyTable {
  kind: 'table'; rect: CaseRect; headers: string[]; rows: string[][]; columnWidths: number[];
  columnPolicy: 'layout_weights' | 'uniform_no_matching_layout_weights' | 'readable_source_row_fields';
  projection: 'columns' | 'row_fields'; sourceTableIndex: number | null; originalColumnCount: number;
  caption: string; captionHeight: number;
  rowHeights: number[]; headerHeight: number; fontSize: number; sourceKeys: string[];
  fragments: { rowIndex: number; fieldIndex: number | null; fragmentIndex: number; fragmentCount: number }[];
}
export interface FullStudyImage { kind: 'image'; rect: CaseRect; image: StudyIllustratedImage }
export interface FullStudyPage {
  panelId: string | null; layoutKey: string | null; title: string; continuation: boolean;
  purpose: 'prefix' | 'panel' | 'image-provenance'; sourceKeys: string[];
  upstreamPageHash: string | null; elements: (FullStudyText | FullStudyTable | FullStudyImage)[];
}
export interface FullStudyPresentation {
  schemaVersion: 1; renderer: string; contractHash: string; templateHash: string;
  revisionId: number; revisionHash: string; caseId: number; clinicalCaseId: number; version: number;
  kind: 'draft' | 'documented'; capturedAt: string; disclosure: 'clinical_case_only';
  sources: StudySavedContent['authored']['sources']; pages: FullStudyPage[]; projectionHash: string;
}
function overlaps(a: CaseRect, b: CaseRect): boolean {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > .005
    && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > .005;
}
function fail(code: string): never { throw Error(`full_study_${code}`); }
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
/** Uniform scaling reserves visible headers/footers even on records-overview.
 * Only rendered coordinates change; selected-use raster aspect and stored geometry do not. */
export function fullStudyInset(rect: CaseRect): CaseRect {
  return { x: (CASE_PAGE.width - CASE_PAGE.width * insetScale) / 2 + rect.x * insetScale,
    y: FULL_STUDY_BODY.y + rect.y * insetScale, w: rect.w * insetScale, h: rect.h * insetScale };
}
export function fullStudyWrap(text: string, width: number, font = BODY_FONT): string[] {
  if (!Number.isFinite(width) || width <= .12 || !Number.isFinite(font) || font < 11 || font > 30) fail('text_frame');
  const characters = Math.floor((width - .12) * 72 / (font * 1.1));
  if (characters < 1) fail('text_frame');
  return text.split('\n').flatMap(line => wrapStudyTextLine(line, characters));
}

/** Native table pagination, repeated headers and explicit row fragments. Never
 * truncates cells, infers clinical values or shrinks text to make it fit. */
export function fullStudyTablePages(headers: string[], rows: string[][], rect: CaseRect, sourceKeys: string[], weights?: readonly number[]): FullStudyTable[] {
  if (!headers.length || headers.length > 12 || rows.length > FULL_STUDY_LIMITS.rows || rows.some(row => row.length !== headers.length)
    || [...headers, ...rows.flat()].some(value => typeof value !== 'string')) fail('table_shape');
  if ([...headers, ...rows.flat()].reduce((size, text) => size + text.length, 0) > FULL_STUDY_LIMITS.text) fail('text_limit');
  if (weights && weights.some(weight => !Number.isFinite(weight) || weight <= 0)) fail('column_weights');
  const matched = weights?.length === headers.length, selected = matched ? weights! : headers.map(() => 1);
  const total = selected.reduce((sum, value) => sum + value, 0), columnWidths = selected.map(weight => rect.w * weight / total);
  const wide = headers.length > 6 || (headers.length > 2 && columnWidths.some(width => width < MIN_COLUMN_WIDTH));
  const paginate = (labels: string[], data: string[][], widths: number[], repeatFieldLabel: boolean): FullStudyTable[] => {
    const wrap = (cells: string[]) => cells.map((text, index) => fullStudyWrap(text, widths[index], TABLE_FONT));
    const headerLines = wrap(labels), line = lineHeight(TABLE_FONT);
    const headerHeight = Math.max(...headerLines.map(lines => lines.length)) * line + PADDING;
    const maximum = Math.floor((rect.h - TABLE_CAPTION_HEIGHT - headerHeight - PADDING) / line);
    if (maximum < 1) fail('table_frame');
    const pages: FullStudyTable[] = [];
    let page: FullStudyTable | null = null, used = 0;
    const newPage = () => {
      page = { kind: 'table', rect: { ...rect }, headers: headerLines.map(lines => lines.join('\n')), rows: [], columnWidths: widths,
        columnPolicy: wide ? 'readable_source_row_fields' : matched ? 'layout_weights' : 'uniform_no_matching_layout_weights',
        projection: wide ? 'row_fields' : 'columns', sourceTableIndex: null, originalColumnCount: headers.length,
        caption: '', captionHeight: TABLE_CAPTION_HEIGHT, rowHeights: [], headerHeight,
        fontSize: TABLE_FONT, sourceKeys: [...sourceKeys], fragments: [] };
      pages.push(page); used = TABLE_CAPTION_HEIGHT + headerHeight;
      if (pages.length > FULL_STUDY_LIMITS.pages) fail('page_limit');
      return page;
    };
    if (!data.length) newPage();
    data.forEach((row, rowIndex) => {
      const cells = wrap(row), count = Math.max(...cells.map(lines => lines.length)), fragments = Math.ceil(count / maximum);
      if (repeatFieldLabel && cells[0].length > maximum) fail('table_frame');
      for (let start = 0; start < count; start += maximum) {
        const lines = cells.map((cell, index) => repeatFieldLabel && index === 0 ? cell : cell.slice(start, start + maximum));
        const height = Math.max(1, ...lines.map(cell => cell.length)) * line + PADDING;
        if (!page || used + height > rect.h + 1e-8) newPage();
        page!.rows.push(lines.map(cell => cell.join('\n'))); page!.rowHeights.push(height);
        page!.fragments.push({ rowIndex, fieldIndex: null, fragmentIndex: start / maximum, fragmentCount: fragments }); used += height;
      }
    });
    return pages;
  };
  if (wide && rows.length) {
    const result: FullStudyTable[] = [];
    rows.forEach((row, sourceRow) => {
      const pages = paginate(['الحقل المسجل', 'القيمة المسجلة'], headers.map((header, column) => [header, row[column]]), [rect.w * .35, rect.w * .65], true);
      pages.forEach((page, index) => {
        page.caption = `صف المصدر: ${sourceRow + 1} من أصل ${rows.length} • جزء ${index + 1} من ${pages.length}`;
        page.fragments = page.fragments.map(fragment => ({ ...fragment, rowIndex: sourceRow, fieldIndex: fragment.rowIndex }));
      });
      result.push(...pages); if (result.length > FULL_STUDY_LIMITS.pages) fail('page_limit');
    });
    return result;
  }
  const pages = paginate(headers, rows, columnWidths, false);
  pages.forEach((page, index) => {
    const first = page.fragments[0]?.rowIndex, last = page.fragments.at(-1)?.rowIndex;
    page.caption = `${first === undefined ? 'لا صفوف مسجلة' : first === last ? `صف المصدر: ${first + 1} من أصل ${rows.length}` : `صفوف المصدر: من ${first + 1} إلى ${last! + 1} من أصل ${rows.length}`} • جزء ${index + 1} من ${pages.length}`;
  });
  return pages;
}

function imageWitness(image: StudyIllustratedImage) {
  return { use: image.use, group: image.group, frame: image.frame, resolutionWarning: image.resolutionWarning,
    sourceSha256: image.sourceSha256, recipeSha256: image.recipeSha256, geometrySha256: image.geometrySha256,
    renditionSha256: image.renditionSha256, processorVersion: image.processorVersion };
}
export function fullStudyProjectionHash(value: Omit<FullStudyPresentation, 'projectionHash'> | FullStudyPresentation): string {
  const { projectionHash: _ignored, ...projection } = value as FullStudyPresentation;
  return journeyContentHash({ ...projection, pages: projection.pages.map(page => ({ ...page,
    elements: page.elements.map(element => element.kind === 'image' ? { ...element, image: imageWitness(element.image) } : element) })) });
}
export function fullStudyPageNotes(value: FullStudyPresentation, page: FullStudyPage) {
  return { renderer: value.renderer, contractHash: value.contractHash, templateHash: value.templateHash,
    projectionHash: value.projectionHash, caseId: value.caseId, clinicalCaseId: value.clinicalCaseId,
    revisionId: value.revisionId, revisionHash: value.revisionHash, version: value.version, kind: value.kind, capturedAt: value.capturedAt,
    panelId: page.panelId, layoutKey: page.layoutKey, continuation: page.continuation, purpose: page.purpose, upstreamPageHash: page.upstreamPageHash,
    sources: value.sources.filter(source => page.sourceKeys.includes(source.key) || page.elements.some(element =>
      element.kind === 'image' && element.image.group?.sourceKeys.includes(source.key))),
    images: page.elements.filter((element): element is FullStudyImage => element.kind === 'image').map(element => imageWitness(element.image)),
    tables: page.elements.filter((element): element is FullStudyTable => element.kind === 'table').map(table => ({
      sourceKeys: table.sourceKeys, projection: table.projection, originalColumnCount: table.originalColumnCount, sourceTableIndex: table.sourceTableIndex, caption: table.caption, columnWidths: table.columnWidths, columnPolicy: table.columnPolicy, fragments: table.fragments,
    })), disclosure: 'Clinical copy. Case-only generated labels do not anonymize clinical text or images. Not approved for educational publication.' };
}
function checkImage(image: StudyIllustratedImage) {
  if (!(image.png instanceof Uint8Array) || image.png.byteLength > FULL_STUDY_LIMITS.pngBytes) fail('png_limit');
  const png = validateCasePng(image.png);
  if (png.width !== image.frame.width || png.height !== image.frame.height || png.sha256 !== image.renditionSha256
    || image.processorVersion !== STUDY_IMAGE_PROCESSOR || image.sourceSha256 !== image.use.sourceSha256
    || image.recipeSha256 !== hashBytes(canonicalOrthoMediaRecipe(image.use.recipe))
    || image.geometrySha256 !== hashBytes(canonicalOrthoMediaGeometryWitness(image.use.recipe, image.frame))) fail('rendition_binding');
}
export function validateFullStudyPresentation(value: FullStudyPresentation): void {
  if (value.schemaVersion !== 1 || value.renderer !== FULL_STUDY_RENDERER || value.contractHash !== FULL_STUDY_CONTRACT_HASH
    || value.templateHash !== journeyContentHash(CASE_TEMPLATE_IDENTITY) || value.disclosure !== 'clinical_case_only'
    || ![value.revisionId, value.caseId, value.clinicalCaseId, value.version].every(positive)
    || !['draft', 'documented'].includes(value.kind) || !/^[a-f0-9]{64}$/.test(value.revisionHash)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.capturedAt) || !Number.isFinite(Date.parse(value.capturedAt))
    || !value.pages.length || value.pages.length > FULL_STUDY_LIMITS.pages) fail('presentation_contract');
  let text = 0, imageBytes = 0, images = 0;
  const keys = new Set(value.sources.map(source => source.key));
  for (const page of value.pages) {
    text += page.title.length;
    if (page.sourceKeys.some(key => !keys.has(key))) fail('source_binding');
    for (const [index, element] of page.elements.entries()) {
      if (page.elements.slice(0, index).some(previous => overlaps(previous.rect, element.rect))) fail('element_overlap');
      const { x, y, w, h } = element.rect;
      if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < FULL_STUDY_BODY.y - 1e-8 || w <= 0 || h <= 0
        || x + w > CASE_PAGE.width + 1e-8 || y + h > FULL_STUDY_BODY.y + FULL_STUDY_BODY.h + 1e-8) fail('element_bounds');
      if (element.kind === 'image') {
        checkImage(element.image); imageBytes += element.image.png.byteLength; images++;
        if (Math.abs(w / h - element.image.frame.width / element.image.frame.height) > .01) fail('image_aspect');
      } else if (element.kind === 'text') {
        if (element.fontSize !== BODY_FONT) fail('text_font');
        text += element.text.length;
      }
      else if (element.kind === 'table') {
        text += element.caption.length;
        text += [...element.headers, ...element.rows.flat()].reduce((size, cell) => size + cell.length, 0);
        if (element.captionHeight !== TABLE_CAPTION_HEIGHT || !element.caption || fullStudyWrap(element.caption, w, TABLE_FONT).length > 2
          || element.fontSize !== TABLE_FONT || !Number.isFinite(element.headerHeight) || element.headerHeight <= 0
          || element.rowHeights.some(height => !Number.isFinite(height) || height <= 0)
          || element.columnWidths.length !== element.headers.length || element.rows.some(row => row.length !== element.headers.length)
          || element.rowHeights.length !== element.rows.length || element.fragments.length !== element.rows.length
          || element.columnWidths.some(width => !Number.isFinite(width) || width <= 0)
          || Math.abs(element.columnWidths.reduce((sum, width) => sum + width, 0) - w) > 1e-8
          || element.captionHeight + element.headerHeight + element.rowHeights.reduce((sum, height) => sum + height, 0) > h + 1e-8) fail('table_bounds');
      } else fail('element_kind');
    }
  }
  if (images > FULL_STUDY_LIMITS.images || imageBytes > FULL_STUDY_LIMITS.imageBytes || text > FULL_STUDY_LIMITS.text) fail('presentation_limit');
  if (fullStudyProjectionHash(value) !== value.projectionHash) fail('projection_changed');
}

export async function fullStudyPresentation(revision: StudyRevision<StudySavedContent>, scope: JourneyScope,
  verified: StudyIllustratedPresentation): Promise<FullStudyPresentation> {
  scope = { ...scope };
  if (JSON.stringify(revision.content).length > 2 * 1024 * 1024) fail('capture_limit');
  // Snapshot before the first await; none of the caller's mutable capture objects
  // may silently replace facts midway through this pure projection.
  const saved = JSON.parse(JSON.stringify(revision)) as StudyRevision<StudySavedContent>;
  const decoded = decodeStudySavedContent(saved.content, scope);
  if (!decoded.ok || ![scope.patientId, scope.orthoCaseId, scope.clinicalCaseId, saved.id, saved.version].every(positive)
    || saved.patientId !== scope.patientId || saved.orthoCaseId !== scope.orthoCaseId || saved.clinicalCaseId !== scope.clinicalCaseId
    || journeyContentHash(saved.content) !== saved.contentHash || verified.caseId !== scope.orthoCaseId
    || verified.revisionId !== saved.id || verified.revisionHash !== saved.contentHash || verified.version !== saved.version
    || verified.kind !== saved.kind || verified.capturedAt !== saved.content.capturedAt) fail('saved_binding');
  if (verified.pages.length > FULL_STUDY_LIMITS.pages) fail('page_limit');
  const imagePages = verified.pages.filter(page => page.image);
  if (imagePages.length > FULL_STUDY_LIMITS.images) fail('image_limit');
  let byteCount = 0;
  const imageByUse = new Map<string, StudyIllustratedImage>();
  for (const page of imagePages) {
    const source = page.image!; byteCount += source.png.byteLength;
    if (byteCount > FULL_STUDY_LIMITS.imageBytes) fail('image_byte_limit');
    if (imageByUse.has(source.use.useId)) fail('duplicate_rendition');
    const { png, ...metadata } = source;
    const image = { ...JSON.parse(JSON.stringify(metadata)), png: Uint8Array.from(png) } as StudyIllustratedImage;
    checkImage(image); imageByUse.set(image.use.useId, image);
  }
  const witness = (presentation: StudyIllustratedPresentation) => ({ ...presentation,
    pages: presentation.pages.map(page => ({ title: page.title, sourceKeys: page.sourceKeys, lines: page.lines,
      image: page.image ? imageWitness(page.image) : null })) });
  const verifiedHash = journeyContentHash(witness(verified));
  const rebuilt = await illustrateSavedStudy(saved, scope, async (use, frame) => {
    const image = imageByUse.get(use.useId);
    if (!image || journeyContentHash(image.use) !== journeyContentHash(use) || journeyContentHash(image.frame) !== journeyContentHash(frame)) fail('selected_image_binding');
    return image;
  });
  if (journeyContentHash(witness(rebuilt)) !== verifiedHash) fail('verified_presentation_changed');

  const panels = saved.content.authored.panels.filter(panel => panel.included), pages: FullStudyPage[] = [];
  if (!panels.length) fail('empty');
  const add = (page: FullStudyPage) => { pages.push(page); if (pages.length > FULL_STUDY_LIMITS.pages) fail('page_limit'); return page; };
  const textual = (page: StudyTextPage, purpose: 'prefix' | 'image-provenance', panelId: string | null, layoutKey: string | null) => {
    const lines = page.lines.flatMap(line => fullStudyWrap(line, FULL_STUDY_BODY.w)), perPage = Math.floor(FULL_STUDY_BODY.h / lineHeight(BODY_FONT));
    for (let start = 0; start < lines.length; start += perPage) add({ panelId, layoutKey, title: start ? `${page.title} — تابع` : page.title,
      continuation: start > 0, purpose, sourceKeys: [...page.sourceKeys], upstreamPageHash: journeyContentHash(page),
      elements: [{ kind: 'text', rect: { ...FULL_STUDY_BODY }, text: lines.slice(start, start + perPage).join('\n'), fontSize: BODY_FONT }] });
  };
  const panelTexts = panels.map(panel => studyTextPresentation(saved, scope, true, panel.instanceId).pages);
  const fullText = studyTextPresentation(saved, scope, true);
  const prefixLength = fullText.pages.length - panelTexts.reduce((sum, list) => sum + list.length, 0);
  for (const page of rebuilt.pages.slice(0, prefixLength)) textual(page, 'prefix', null, null);
  let cursor = prefixLength;
  panels.forEach((panel, panelIndex) => {
    const layout = caseLayout(panel.layoutKey); if (!layout) fail('layout_unknown');
    const sourceKeys = panel.state === 'available' ? [...panel.sourceKeys] : [];
    const base = (continuation = false): FullStudyPage => ({ panelId: panel.instanceId, layoutKey: layout.key,
      title: `${layout.titleAr}${continuation ? ' — تابع' : ''}`, continuation, purpose: 'panel', sourceKeys,
      upstreamPageHash: null, elements: [] });
    const first = add(base());
    for (const binding of panel.images) {
      const slot = layout.images.find(slot => slot.slotId === binding.slot && slot.sourceKind === 'patient-document');
      const image = imageByUse.get(binding.useId);
      if (!slot || !image || panel.state !== 'available') fail('selected_image_binding');
      const frame = fullStudyInset(slot), scale = Math.min(frame.w / image.frame.width, frame.h / image.frame.height);
      const w = image.frame.width * scale, h = image.frame.height * scale;
      first.elements.push({ kind: 'image', rect: { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h }, image });
    }
    let textPage: FullStudyPage | null = first, textRect = panel.images.length ? fullStudyInset(layout.text) : { ...FULL_STUDY_BODY }, used = 0;
    const nextTextPage = () => { textPage = add(base(true)); textRect = { ...FULL_STUDY_BODY }; used = 0; };
    const paragraph = (text: string) => {
      if (!textPage || textRect.h < lineHeight(BODY_FONT)
        || (textPage === first && first.elements.some(element => element.kind !== 'text' && overlaps(element.rect, textRect)))) nextTextPage();
      for (const line of fullStudyWrap(text, textRect.w)) {
        if (used + lineHeight(BODY_FONT) > textRect.h + 1e-8) nextTextPage();
        textPage!.elements.push({ kind: 'text', rect: { x: textRect.x, y: textRect.y + used, w: textRect.w, h: lineHeight(BODY_FONT) }, text: line, fontSize: BODY_FONT });
        used += lineHeight(BODY_FONT);
      }
    };
    if (panel.state !== 'available') paragraph(`حالة القسم: ${panel.state === 'not_recorded' ? 'غير مسجل' : panel.state === 'restricted' ? 'مقيّد' : 'غير متاح'}`);
    const facts = projectStudyRecordedFacts(saved.content, scope, panel.instanceId, saved.kind);
    let tablePlaced = false;
    for (const [blockIndex, block] of facts.blocks.entries()) {
      if (block.kind === 'paragraph') { paragraph(block.text); continue; }
      const keys = [...new Set(block.rows.flatMap(row => row.sourceKeys))];
      let compact: FullStudyTable[] | null = null;
      if (layout.table && !tablePlaced && pages.at(-1) === first
        && !first.elements.some(element => overlaps(element.rect, fullStudyInset(layout.table!)))) {
        try { compact = fullStudyTablePages(block.headers, block.rows.map(row => row.cells), fullStudyInset(layout.table), keys, layout.columnWeights); }
        catch (error) { if (!(error instanceof Error) || !['full_study_table_frame', 'full_study_text_frame'].includes(error.message)) throw error; }
      }
      const markSourceTable = (table: FullStudyTable) => { table.sourceTableIndex = blockIndex; table.caption = `جدول ${blockIndex + 1} • ${table.caption}`; return table; };
      if (compact?.length === 1) first.elements.push(markSourceTable(compact[0]));
      else for (const table of fullStudyTablePages(block.headers, block.rows.map(row => row.cells), { ...FULL_STUDY_BODY }, keys, layout.columnWeights)) {
        add({ ...base(true), elements: [markSourceTable(table)] });
      }
      tablePlaced = true; textPage = null;
    }
    if (panel.images.length) paragraph('الصور المختارة لهذا القسم مرفقة بإطاراتها المحفوظة؛ مصادرها وتعليقاتها في صفحات مستقلة.');
    else if (panel.sourceKeys.some(key => saved.content.sources.some(source => source.selection.key === key && source.selection.kind === 'document'))) {
      paragraph('يوجد مرجع مستند دون صورة مختارة للتصدير في هذا القسم.');
    }
    for (const comment of [saved.content.authored.comment, panel.comment].filter(Boolean)) paragraph(`تعليق الطبيب: ${comment}`);
    const sourceName = (key: string) => { const selection = saved.content.authored.sources.find(source => source.key === key);
      return selection ? `${studySourceName(selection.kind, 'ar')} #${selection.id}` : 'مرجع الدراسة'; };
    for (const item of facts.unavailable) paragraph(`مصدر غير متاح: ${sourceName(item.sourceKey)}. راجع المصدر داخل ملف الحالة.`);
    for (const item of facts.unmapped) paragraph(`تفاصيل المصدر غير معروضة نصياً في هذا القسم: ${sourceName(item.sourceKey)}. راجعها داخل ملف الحالة.`);
    if (!facts.blocks.length && !facts.unavailable.length && !facts.unmapped.length && panel.state === 'available'
      && !panel.comment && !saved.content.authored.comment && !panel.images.length) paragraph('لا توجد حقائق نصية مسجلة في هذا القسم.');
    if (!first.elements.length) pages.splice(pages.indexOf(first), 1);

    // Preserve the exact existing image provenance/caption pages, including unknown
    // dates and filtered group source keys, rather than inventing a second caption policy.
    cursor += panelTexts[panelIndex].length;
    for (const binding of panel.images) {
      const imagePage = rebuilt.pages[cursor++];
      if (imagePage?.image?.use.useId !== binding.useId) fail('image_page_binding');
      textual({ title: `${layout.titleAr} — مرجع الصورة`, lines: [...imagePage.lines, ...(imagePage.image!.resolutionWarning ? ['دقة الأصل أقل من حجم الإطار؛ راجع وضوح الصورة.'] : [])], sourceKeys: imagePage.sourceKeys }, 'image-provenance', panel.instanceId, layout.key);
      while (rebuilt.pages[cursor] && !rebuilt.pages[cursor].image && rebuilt.pages[cursor].title === `${layout.titleAr} — تعليق الصورة`) {
        textual(rebuilt.pages[cursor++], 'image-provenance', panel.instanceId, layout.key);
      }
    }
  });
  if (cursor !== rebuilt.pages.length) fail('unconsumed_provenance');
  const exportedKeys = new Set(pages.flatMap(page => page.sourceKeys));
  const value: FullStudyPresentation = { schemaVersion: 1, renderer: FULL_STUDY_RENDERER, contractHash: FULL_STUDY_CONTRACT_HASH,
    templateHash: journeyContentHash(CASE_TEMPLATE_IDENTITY), revisionId: saved.id, revisionHash: saved.contentHash,
    caseId: scope.orthoCaseId, clinicalCaseId: scope.clinicalCaseId, version: saved.version, kind: saved.kind,
    capturedAt: saved.content.capturedAt, disclosure: 'clinical_case_only',
    sources: saved.content.authored.sources.filter(source => exportedKeys.has(source.key)), pages, projectionHash: '' };
  value.projectionHash = fullStudyProjectionHash(value); validateFullStudyPresentation(value); return value;
}

// This list is informational: repeated visits/panels retain their saved order;
// the renderer never expands the registry into a forced reference slide count.
export const FULL_STUDY_LAYOUT_KEYS = Object.freeze(CASE_LAYOUTS.map(layout => layout.key));
