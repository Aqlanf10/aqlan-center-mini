import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import JSZip from 'jszip';
import { CASE_LAYOUTS, CASE_PAGE, CASE_TEMPLATE_IDENTITY, CASE_TEMPLATE_VERSION, caseLayout } from '../lib/ortho-case-template';
import { STUDY_TEMPLATE_HASH } from '../lib/ortho-case-study-template';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { hashBytes } from '../lib/ortho-case-render-security';
import { fullStudyPresentation, fullStudyTablePages, fullStudyInset, fullStudyProjectionHash, validateFullStudyPresentation,
  FULL_STUDY_BODY, FULL_STUDY_LIMITS, FULL_STUDY_RENDERER, fullStudyPageNotes, type FullStudyPresentation, type FullStudyTable } from '../lib/ortho-study-full-layout';
import { renderFullStudyPptx } from '../lib/ortho-study-full-pptx';
import { illustrateSavedStudy } from '../lib/ortho-study-illustrated';
import { projectStudyRecordedFacts } from '../lib/ortho-case-study-recorded-facts';
import { studyTextPresentation } from '../lib/ortho-study-text-export';
import { renderStudyImage } from '../lib/ortho-study-image-processor';
import { defaultOrthoMediaRecipe } from '../lib/ortho-study-media';
import type { StudySavedContent } from '../lib/ortho-case-study-capture';
import type { StudyRevision } from '../lib/ortho-case-study-history';
import { spaceStudyFixture, spaceStudyScope } from './fixtures/ortho-study-space';
import { syntheticLongitudinalStudy } from './fixtures/ortho-study-longitudinal';

const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
function bare(layouts = ['cover', 'interview', 'visit', 'visit']): StudyRevision<StudySavedContent> {
  const content: StudySavedContent = { schemaVersion: 1, capturedAt: '2026-11-04T00:00:00.000Z', recordedPatientId: 1,
    orthoCaseId: 2, clinicalCaseId: 3, caseStatusAtCapture: 'active', sources: [], authored: {
      template: { key: 'full-orthodontic-case', version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
      identityDisclosure: 'case_only', sources: [], groups: [], mediaUses: [], comment: '',
      panels: layouts.map((layoutKey, index) => ({ instanceId: `panel_${index}`, layoutKey, included: true,
        state: 'not_recorded', sourceKeys: [], images: [], comment: `Synthetic entry ${index}` })),
    } };
  return { ...scope, id: 4, actorId: 5, version: 1, recordedPatientId: 1, schemaVersion: 1, predecessorId: null,
    kind: 'draft', documentedFromId: null, baseDocumentedId: null, createdAt: content.capturedAt, reason: 'Synthetic full export',
    contentHash: journeyContentHash(content), content };
}
const rehash = (revision: StudyRevision<StudySavedContent>) => { revision.contentHash = journeyContentHash(revision.content); return revision; };
const noImage = async (): Promise<never> => { throw Error('no image expected'); };
async function plain(revision = bare()) {
  const verified = await illustrateSavedStudy(revision, scope, noImage);
  return { revision, verified, full: await fullStudyPresentation(revision, scope, verified) };
}
async function imageFixture() {
  const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ee3322' } })
    .composite([{ input: await sharp({ create: { width: 60, height: 80, channels: 3, background: '#2244ee' } }).png().toBuffer(), left: 60, top: 0 }])
    .withMetadata({ orientation: 1 }).png().toBuffer();
  const sourceHash = hashBytes(bytes), revision = bare(['records-overview', 'visit', 'visit']);
  const content = revision.content, selection = { key: 'image', kind: 'document' as const, id: 6, version: null, contentHash: sourceHash };
  const hidden = { key: 'EXCLUDED_PRIVATE_SOURCE', kind: 'document' as const, id: 7, version: null, contentHash: 'b'.repeat(64) };
  content.authored.sources = [selection, hidden];
  content.sources = [{ selection, state: 'available', unavailableReason: null, access: { images: true, plans: false },
    payload: { id: 6, title: 'Synthetic image', mimeType: 'image/png', sizeBytes: bytes.length, contentHash: sourceHash, width: 120, height: 80 } },
  { selection: hidden, state: 'unavailable', unavailableReason: 'document_removed', access: { images: true, plans: false }, payload: null }];
  content.authored.groups = [{ id: 'group1', label: 'Synthetic T1', phase: 'T1', sourceKeys: ['image', hidden.key],
    occurrence: { occurredOn: null, dateProvenance: 'unknown', sourceNote: 'Synthetic date is not known' } }];
  content.authored.mediaUses = ['left', 'right'].map((useId, index) => ({ useId, documentId: 6, sourceSha256: sourceHash,
    groupId: 'group1', slotId: index ? 'face-front' : 'face-profile', order: index, view: 'face-rest',
    caption: index ? 'Synthetic second crop' : 'ع🙂'.repeat(100), recipe: { ...defaultOrthoMediaRecipe(120, 80, 1),
      cropPpm: { top: 0, bottom: 1000000, left: index ? 500000 : 0, right: index ? 1000000 : 500000 } } }));
  content.authored.panels[0] = { ...content.authored.panels[0], state: 'available', sourceKeys: ['image'],
    images: [{ slot: 'face-profile', useId: 'left' }, { slot: 'face-front', useId: 'right' }] };
  content.authored.panels.push({ instanceId: 'excluded', layoutKey: 'visit', included: false, state: 'available', sourceKeys: [hidden.key], images: [], comment: 'EXCLUDED_PRIVATE_COMMENT' });
  rehash(revision);
  const verified = await illustrateSavedStudy(revision, scope, (use, frame) => renderStudyImage(bytes, use.recipe, frame));
  return { bytes, revision, verified, full: await fullStudyPresentation(revision, scope, verified) };
}
function texts(value: FullStudyPresentation) {
  return value.pages.flatMap(page => page.elements.flatMap(element => element.kind === 'text' ? [element.text]
    : element.kind === 'table' ? [...element.headers, ...element.rows.flat()] : [])).join('');
}
const reproject = (value: FullStudyPresentation) => { value.projectionHash = fullStudyProjectionHash(value); return value; };
async function slideXml(zip: JSZip) {
  return Promise.all(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/slide(\d+)/.exec(a)![1]) - Number(/slide(\d+)/.exec(b)![1])).map(name => zip.file(name)!.async('text')));
}

describe('versioned full saved study projection', () => {
  it('supports every current layout, keeps repeated visits, and never mutates the saved template or capture', async () => {
    const revision = bare([...CASE_LAYOUTS.map(layout => layout.key), 'visit']), before = JSON.stringify(revision);
    const { full } = await plain(revision);
    expect(JSON.stringify(revision)).toBe(before);
    expect(full.templateHash).toBe(journeyContentHash(CASE_TEMPLATE_IDENTITY));
    expect(full.revisionHash).toBe(revision.contentHash);
    expect([...new Set(full.pages.filter(page => page.panelId).map(page => page.panelId))]).toEqual(revision.content.authored.panels.map(panel => panel.instanceId));
    expect(full.pages.filter(page => page.layoutKey === 'visit').length).toBeGreaterThanOrEqual(2);
    expect(texts(full)).toContain('غير مسجل');
    expect(full.pages.filter(page => page.purpose === 'prefix' && page.title === 'سياق التقاط الدراسة المحفوظة')).toHaveLength(1);
    expect(texts(full)).toContain(revision.content.capturedAt);
    expect(full.disclosure).toBe('clinical_case_only');
    expect(JSON.stringify(full)).not.toContain('patientName');
  });
  it('uses the full readable body for text-only visits instead of empty image-slot geometry', async () => {
    const revision = bare(['visit', 'visit']);
    revision.content.authored.panels.forEach((panel, index) => { panel.comment = `زيارة اختبار ${index + 1}: ملاحظة عربية مع 11-12 و2.5 mm بتاريخ 2020-02-29. لم تسجل صورة؛ لا تفترض نتيجة علاجية.`; });
    rehash(revision);
    const { full } = await plain(revision);
    for (const panel of revision.content.authored.panels) {
      const pages = full.pages.filter(page => page.panelId === panel.instanceId);
      expect(pages).toHaveLength(1);
      const text = pages[0].elements.filter(element => element.kind === 'text');
      expect(text.length).toBeGreaterThan(1); expect(text.every(element => element.rect.w === FULL_STUDY_BODY.w)).toBe(true);
      expect(text[0].rect.y).toBe(FULL_STUDY_BODY.y);
    }
  });
  it('retains all current historical prefix facts, unknown dates and longitudinal limits once', async () => {
    const revision = syntheticLongitudinalStudy(), historyScope = { patientId: revision.patientId, orthoCaseId: revision.orthoCaseId, clinicalCaseId: revision.clinicalCaseId };
    const verified = await illustrateSavedStudy(revision, historyScope, noImage);
    const full = await fullStudyPresentation(revision, historyScope, verified);
    const text = studyTextPresentation(revision, historyScope, true), panels = revision.content.authored.panels.filter(panel => panel.included);
    const prefix = text.pages.slice(0, text.pages.length - panels.flatMap(panel => studyTextPresentation(revision, historyScope, true, panel.instanceId).pages).length);
    expect(prefix.length).toBeGreaterThan(4);
    expect([...new Set(full.pages.filter(page => page.purpose === 'prefix').map(page => page.upstreamPageHash))]).toEqual(prefix.map(page => journeyContentHash(page)));
    for (const page of prefix) {
      const displayed = full.pages.filter(projected => projected.upstreamPageHash === journeyContentHash(page)).flatMap(projected => projected.elements.flatMap(element => element.kind === 'text' ? [element.text] : [])).join('').replaceAll('\n', '');
      expect(displayed).toBe(page.lines.join(''));
    }
    expect(texts(full)).toContain('غير معروف');
  });
  it('keeps an available empty panel explicit and refuses a wholly excluded selection', async () => {
    const revision = bare(['cover']); revision.content.authored.panels[0].state = 'available'; revision.content.authored.panels[0].comment = ''; rehash(revision);
    expect(texts((await plain(revision)).full)).toContain('لا توجد حقائق نصية مسجلة');
    revision.content.authored.panels[0].included = false; rehash(revision);
    await expect(plain(revision)).rejects.toThrow('study_text_export_empty');
  });
  it.each(['caseId', 'revisionId', 'revisionHash', 'version', 'kind', 'capturedAt'] as const)('rejects mismatched verified %s', async field => {
    const { revision, verified } = await plain();
    const wrong = { ...verified, [field]: typeof verified[field] === 'number' ? 999 : field === 'kind' ? 'documented' : 'wrong' };
    await expect(fullStudyPresentation(revision, scope, wrong)).rejects.toThrow('full_study_saved_binding');
  });
  it('rejects a stale content hash, another owner, and altered prefix text', async () => {
    const { revision, verified } = await plain();
    await expect(fullStudyPresentation(revision, { ...scope, patientId: 99 }, verified)).rejects.toThrow('full_study_saved_binding');
    revision.content.authored.comment = 'Uncommitted replacement';
    await expect(fullStudyPresentation(revision, scope, verified)).rejects.toThrow('full_study_saved_binding');
    revision.content.authored.comment = '';
    verified.pages[0].lines[0] = 'Unverified capture status';
    await expect(fullStudyPresentation(revision, scope, verified)).rejects.toThrow('full_study_verified_presentation_changed');
  });
  it('preserves exact processed image, saved caption and filtered group witness without original bytes or hidden sources', async () => {
    const { revision, verified, full } = await imageFixture();
    const images = full.pages.flatMap(page => page.elements.filter(element => element.kind === 'image'));
    expect(images).toHaveLength(2);
    for (const image of images) {
      const original = verified.pages.find(page => page.image?.use.useId === image.image.use.useId)!.image!;
      expect(image.image.png).toEqual(new Uint8Array(original.png));
      const slot = caseLayout('records-overview')!.images.find(slot => slot.slotId === image.image.use.slotId)!;
      const inset = fullStudyInset(slot);
      expect(image.rect.x).toBeGreaterThanOrEqual(inset.x); expect(image.rect.y).toBeGreaterThanOrEqual(inset.y);
      expect(image.rect.w).toBeLessThanOrEqual(inset.w + 1e-10); expect(image.rect.h).toBeLessThanOrEqual(inset.h + 1e-10);
      expect(image.rect.w / image.rect.h).toBeCloseTo(image.image.frame.width / image.image.frame.height, 10);
      expect(image.rect.y).toBeGreaterThan(1.1);
      expect(image.rect.y + image.rect.h).toBeLessThan(6.85);
    }
    expect(texts(full).replaceAll('\n', '')).toContain('ع🙂'.repeat(100));
    expect(texts(full)).toContain('تاريخ المجموعة: غير معروف');
    expect(texts(full)).toContain('دقة الأصل أقل من حجم الإطار');
    const notes = JSON.stringify(full.pages.map(page => fullStudyPageNotes(full, page)));
    expect(notes).toContain(revision.content.authored.mediaUses[0].sourceSha256);
    expect(notes).not.toContain('EXCLUDED_PRIVATE_SOURCE'); expect(texts(full)).not.toContain('EXCLUDED_PRIVATE_COMMENT');
    expect(notes).toContain('Not approved for educational publication');
  });
  it('rejects altered selected image metadata, bytes, captions, missing and duplicate renditions', async () => {
    const { revision, verified } = await imageFixture();
    const image = verified.pages.find(page => page.image)!.image!;
    const recipeHash = image.recipeSha256; image.recipeSha256 = 'a'.repeat(64);
    await expect(fullStudyPresentation(revision, scope, verified)).rejects.toThrow('full_study_rendition_binding'); image.recipeSha256 = recipeHash;
    const group = image.group!; group.label = 'Unverified group';
    await expect(fullStudyPresentation(revision, scope, verified)).rejects.toThrow('full_study_verified_presentation_changed'); group.label = 'Synthetic T1';
    const png = image.png; image.png = new Uint8Array(png); image.png[image.png.length - 1] ^= 1;
    await expect(fullStudyPresentation(revision, scope, verified)).rejects.toThrow(); image.png = png;
    const index = verified.pages.findIndex(page => page.image), page = verified.pages[index];
    verified.pages.splice(index, 1);
    await expect(fullStudyPresentation(revision, scope, verified)).rejects.toThrow('full_study_selected_image_binding'); verified.pages.splice(index, 0, page);
    verified.pages.push(page);
    await expect(fullStudyPresentation(revision, scope, verified)).rejects.toThrow('full_study_duplicate_rendition');
  });
  it('snapshots caller-owned capture and verified images before any asynchronous continuation', async () => {
    const { revision, verified } = await imageFixture();
    const originalHash = revision.contentHash, image = verified.pages.find(page => page.image)!.image!, originalImageHash = image.renditionSha256;
    const pending = fullStudyPresentation(revision, scope, verified);
    revision.content.authored.comment = 'MUTATED_AFTER_CALL'; verified.pages[0].lines[0] = 'MUTATED_AFTER_CALL'; image.png[0] ^= 1;
    const full = await pending;
    expect(full.revisionHash).toBe(originalHash); expect(texts(full)).not.toContain('MUTATED_AFTER_CALL');
    const savedImage = full.pages.flatMap(page => page.elements.filter(element => element.kind === 'image'))[0].image;
    expect(hashBytes(savedImage.png)).toBe(originalImageHash);
  });
  it('enforces rendition count and byte admission before PNG processing', async () => {
    const { revision, verified } = await imageFixture();
    const page = verified.pages.find(page => page.image)!;
    await expect(fullStudyPresentation(revision, scope, { ...verified, pages: Array.from({ length: 41 }, () => page) })).rejects.toThrow('full_study_image_limit');
    const png = page.image!.png; page.image!.png = new Uint8Array(FULL_STUDY_LIMITS.imageBytes + 1);
    await expect(fullStudyPresentation(revision, scope, verified)).rejects.toThrow('full_study_image_byte_limit'); page.image!.png = png;
  });
  it('refuses projection edits, image overlap, out-of-bounds geometry, extra pages and text limits', async () => {
    const { full } = await plain();
    full.pages[0].title = 'Changed'; expect(() => validateFullStudyPresentation(full)).toThrow('full_study_projection_changed');
    reproject(full);
    const element = full.pages[0].elements[0]; full.pages[0].elements.push(element);
    expect(() => validateFullStudyPresentation(reproject(full))).toThrow('full_study_element_overlap'); full.pages[0].elements.pop();
    const oldY = element.rect.y; element.rect.y = 0;
    expect(() => validateFullStudyPresentation(reproject(full))).toThrow('full_study_element_bounds'); element.rect.y = oldY;
    const originalPages = full.pages; full.pages = Array.from({ length: FULL_STUDY_LIMITS.pages + 1 }, () => originalPages[0]);
    expect(() => validateFullStudyPresentation(reproject(full))).toThrow('full_study_presentation_contract'); full.pages = originalPages;
    if (element.kind !== 'text') throw Error('fixture'); element.text = 'a'.repeat(FULL_STUDY_LIMITS.text + 1);
    expect(() => validateFullStudyPresentation(reproject(full))).toThrow('full_study_presentation_limit');
  });
});

describe('native full study tables and PowerPoint package', () => {
  it('pins output admission to the existing 24 MiB archive bound', () => {
    expect(FULL_STUDY_LIMITS.outputBytes).toBe(24 * 1024 * 1024);
  });
  it('honors matching column weights, repeats headers and preserves every grapheme in explicit long-row fragments', () => {
    const long = 'ع🙂'.repeat(1000), headers = ['Problem', 'Plan', 'Strategy'];
    const tables = fullStudyTablePages(headers, [[long, 'Recorded plan', 'Recorded strategy'], ['Next problem', 'No estimate', 'Unknown']], FULL_STUDY_BODY, ['source'], [1, 2, 3]);
    expect(tables.length).toBeGreaterThan(1);
    expect(tables.every(table => table.columnPolicy === 'layout_weights')).toBe(true);
    expect(tables[0].columnWidths[1] / tables[0].columnWidths[0]).toBeCloseTo(2);
    expect(tables[0].columnWidths[2] / tables[0].columnWidths[0]).toBeCloseTo(3);
    for (const table of tables) { expect(table.headers).toEqual(headers); expect(table.captionHeight + table.headerHeight + table.rowHeights.reduce((sum, height) => sum + height, 0)).toBeLessThanOrEqual(FULL_STUDY_BODY.h); }
    const fragments = tables.flatMap(table => table.rows.map((cells, index) => ({ cells, fragment: table.fragments[index] }))).filter(row => row.fragment.rowIndex === 0);
    expect(fragments.map(row => row.cells[0]).join('').replaceAll('\n', '')).toBe(long);
    expect(fragments.map(row => row.fragment.fragmentIndex)).toEqual(fragments.map((_, index) => index));
    expect(fragments.every(row => row.fragment.fragmentCount === fragments.length)).toBe(true);
    expect(tables.at(-1)!.rows.at(-1)!.map(cell => cell.replaceAll('\n', ''))).toEqual(['Next problem', 'No estimate', 'Unknown']);
  });
  it('turns wide source rows into readable field/value tables with visible row and field association on every continuation', () => {
    const headers = Array.from({ length: 12 }, (_, index) => `Field ${index + 1}`);
    const rows = [headers.map((_, index) => index === 11 ? 'ع🙂'.repeat(900) : `FIRST_${index}`), headers.map((_, index) => `SECOND_${index}`)];
    const tables = fullStudyTablePages(headers, rows, FULL_STUDY_BODY, ['saved_source']);
    const reconstructed = rows.map(row => row.map(() => ''));
    for (const table of tables) {
      expect(table.projection).toBe('row_fields'); expect(table.columnPolicy).toBe('readable_source_row_fields');
      expect(table.headers).toEqual(['الحقل المسجل', 'القيمة المسجلة']);
      expect(table.columnWidths.every(width => width > 3)).toBe(true);
      expect(table.caption).toMatch(/صف المصدر [12]\/2 • جزء \d+\/\d+/);
      for (const [index, cells] of table.rows.entries()) {
        const fragment = table.fragments[index]; if (fragment.fieldIndex === null) throw Error('missing source field');
        expect(cells[0].replaceAll('\n', '')).toBe(headers[fragment.fieldIndex]);
        reconstructed[fragment.rowIndex][fragment.fieldIndex] += cells[1].replaceAll('\n', '');
      }
    }
    expect(reconstructed).toEqual(rows);
    expect(tables.filter(table => table.fragments.some(fragment => fragment.fragmentIndex > 0)).length).toBeGreaterThan(1);
  });
  it('labels incompatible header counts explicitly and refuses malformed/excessive table input', () => {
    expect(fullStudyTablePages(['A', 'B'], [['x', 'y']], FULL_STUDY_BODY, [], [1, 2, 3])[0].columnPolicy).toBe('uniform_no_matching_layout_weights');
    expect(() => fullStudyTablePages(['A'], [['x', 'y']], FULL_STUDY_BODY, [])).toThrow('full_study_table_shape');
    expect(() => fullStudyTablePages(['A'], [['x']], FULL_STUDY_BODY, [], [-1])).toThrow('full_study_column_weights');
    expect(() => fullStudyTablePages(['A'], Array.from({ length: 4001 }, () => ['x']), FULL_STUDY_BODY, [])).toThrow('full_study_table_shape');
    expect(() => fullStudyTablePages(['A'], [['x'.repeat(240001)]], FULL_STUDY_BODY, [])).toThrow('full_study_text_limit');
    expect(() => fullStudyTablePages(['A'], [['x'.repeat(100000)]], { ...FULL_STUDY_BODY, w: .5, h: 1.5 }, [])).toThrow('full_study_page_limit');
  });
  it('renders all registry layouts with native editable text, visible draft marks on EVERY slide and normalized capture metadata', async () => {
    const { full } = await plain(bare(CASE_LAYOUTS.map(layout => layout.key)));
    const zip = await JSZip.loadAsync(await renderFullStudyPptx(full)), slides = await slideXml(zip);
    expect(slides).toHaveLength(full.pages.length);
    for (const xml of slides) {
      expect(xml).toContain('مسودة'); expect(xml).toContain('الحالة 2'); expect(xml).toContain('ليست للنشر التعليمي');
      expect(xml).toContain('<a:t>'); expect(xml).not.toContain('<a:spAutoFit');
    }
    expect(await zip.file('ppt/presentation.xml')!.async('text')).toContain(`cx="${CASE_PAGE.width * 914400}" cy="${CASE_PAGE.height * 914400}"`);
    const core = await zip.file('docProps/core.xml')!.async('text');
    expect(core).toContain(full.capturedAt); expect(core).not.toContain('patientName');
    expect(Object.keys(zip.files).some(name => /embeddings|customXml|\.bin$/.test(name))).toBe(false);
  });
  it('embeds only verified cropped PNGs, exact source witnesses and editable captions, with no external relationships', async () => {
    const { bytes, verified, full } = await imageFixture(), zip = await JSZip.loadAsync(await renderFullStudyPptx(full));
    const media = await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/media\//.test(name)).map(name => zip.file(name)!.async('nodebuffer')));
    expect(media).toHaveLength(2); expect(media.some(png => png.equals(bytes))).toBe(false);
    for (const page of verified.pages.filter(page => page.image)) expect(media.some(png => png.equals(Buffer.from(page.image!.png)))).toBe(true);
    const slides = await slideXml(zip), notes = (await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).map(name => zip.file(name)!.async('text')))).join('');
    expect(notes).toContain(full.revisionHash); expect(notes).toContain(full.projectionHash); expect(notes).toContain(FULL_STUDY_RENDERER);
    for (const page of verified.pages.filter(page => page.image)) for (const field of ['sourceSha256', 'recipeSha256', 'geometrySha256', 'renditionSha256'] as const) expect(notes).toContain(page.image![field]);
    expect(notes).not.toContain('EXCLUDED_PRIVATE_SOURCE'); expect(slides.join('')).not.toContain('EXCLUDED_PRIVATE_COMMENT');
    for (const name of Object.keys(zip.files).filter(name => name.endsWith('.rels'))) expect(await zip.file(name)!.async('text')).not.toContain('TargetMode="External"');
    const records = full.pages.findIndex(page => page.layoutKey === 'records-overview' && page.elements.some(element => element.kind === 'image'));
    expect(slides[records]).toContain('مسودة'); expect(slides[records]).toContain('<p:pic>');
  });
  it('projects real recorded source facts into editable native tables without clipping or invented clinical numbers', async () => {
    const { revision } = spaceStudyFixture(), verified = await illustrateSavedStudy(revision, spaceStudyScope, noImage);
    const full = await fullStudyPresentation(revision, spaceStudyScope, verified), tables = full.pages.flatMap(page => page.elements.filter((element): element is FullStudyTable => element.kind === 'table'));
    expect(tables.length).toBeGreaterThan(0); expect(texts(full).replaceAll('\n', '')).toContain('SYNTHETIC_ORIGINAL_PLAN');
    const blocks = projectStudyRecordedFacts(revision.content, spaceStudyScope, 'space_panel', revision.kind).blocks;
    for (const [blockIndex, block] of blocks.entries()) {
      if (block.kind === 'paragraph') { expect(texts(full).replaceAll('\n', '')).toContain(block.text.replaceAll('\n', '')); continue; }
      const reconstructed = block.rows.map(() => block.headers.map(() => ''));
      const sourceTables = tables.filter(table => table.sourceTableIndex === blockIndex);
      expect(sourceTables.length).toBeGreaterThan(0);
      for (const table of sourceTables) {
        expect(table.caption).toContain(`جدول ${blockIndex + 1}`);
        table.rows.forEach((row, rowIndex) => {
          const fragment = table.fragments[rowIndex];
          if (table.projection === 'row_fields') {
            if (fragment.fieldIndex === null) throw Error('missing original field mapping');
            expect(row[0].replaceAll('\n', '')).toBe(block.headers[fragment.fieldIndex].replaceAll('\n', ''));
            reconstructed[fragment.rowIndex][fragment.fieldIndex] += row[1].replaceAll('\n', '');
          } else row.forEach((cell, column) => { reconstructed[fragment.rowIndex][column] += cell.replaceAll('\n', ''); });
        });
      }
      expect(reconstructed).toEqual(block.rows.map(row => row.cells.map(cell => cell.replaceAll('\n', ''))));
    }
    const zip = await JSZip.loadAsync(await renderFullStudyPptx(full)), slides = await slideXml(zip);
    expect(slides.join('')).toContain('<a:tbl>'); expect(slides.join('').replace(/<[^>]*>/g, '').replaceAll('\n', '')).toContain('SYNTHETIC_ORIGINAL_PLAN');
    for (const [index, page] of full.pages.entries()) for (const table of page.elements.filter((element): element is FullStudyTable => element.kind === 'table')) {
      const widths = [...slides[index].matchAll(/<a:gridCol w="(\d+)"/g)].map(match => Number(match[1]));
      expect(widths).toEqual(table.columnWidths.map(width => Math.round(width * 914400)));
      const heights = [...slides[index].matchAll(/<a:tr h="(\d+)"/g)].map(match => Number(match[1]));
      expect(heights.reduce((sum, height) => sum + height, 0) / 914400).toBeLessThanOrEqual(table.rect.h - table.captionHeight + .001);
    }
  });
  it('renders synthetic weighted multi-page tables with explicit row-fragment notes and a documented mark on every continuation', async () => {
    const { full } = await plain(bare(['cover'])); full.kind = 'documented';
    const tables = fullStudyTablePages(['A', 'B', 'C'], [['ع🙂'.repeat(600), 'Recorded 11-12', 'Unknown']], FULL_STUDY_BODY, [], [1, 2, 3]);
    full.pages = tables.map((table, index) => ({ panelId: 'synthetic_table', layoutKey: 'problem-plan-strategy', title: 'Synthetic table', continuation: index > 0,
      purpose: 'panel', sourceKeys: [], upstreamPageHash: null, elements: [table] })); reproject(full);
    const zip = await JSZip.loadAsync(await renderFullStudyPptx(full)), slides = await slideXml(zip);
    expect(slides).toHaveLength(tables.length);
    slides.forEach((xml, index) => { expect(xml).toContain('نسخة موثقة'); expect(xml).toContain('<a:tbl>'); expect(xml).toContain('صف المصدر'); expect(xml).toContain('جزء');
      expect([...xml.matchAll(/<a:gridCol w="(\d+)"/g)].map(match => Number(match[1]))).toEqual(tables[index].columnWidths.map(width => Math.round(width * 914400))); });
    const notes = await zip.file('ppt/notesSlides/notesSlide2.xml')!.async('text'); expect(notes).toContain('fragmentIndex'); expect(notes).toContain('layout_weights');
  });
});
