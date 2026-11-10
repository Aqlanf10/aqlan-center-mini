import { checkedStudyPageNotes } from "./ortho-study-model-analysis-evidence";
import pptxgen from 'pptxgenjs';
import JSZip from 'jszip';
import { CASE_PAGE } from './ortho-case-template';
import { inspectCasePackage, hashBytes } from './ortho-case-render-security';
import { isolateStudyDateTokens } from './ortho-study-display';
import { FULL_STUDY_LIMITS, FULL_STUDY_RENDERER, fullStudyPageNotes, validateFullStudyPresentation,
  type FullStudyPresentation } from './ortho-study-full-layout';

function fail(code: string): never { throw Error(`full_study_${code}`); }
// PptxGenJS 4.0.1's fixed, nonclinical Office metadata. Remove only these exact
// generated extensions; unexpected extension/active content still fails closed.
const generatedMetadataExtensions = [
  '<a:extLst><a:ext uri="{05A4C25C-085E-4340-85A3-A5531E510DB2}"><thm15:themeFamily xmlns:thm15="http://schemas.microsoft.com/office/thememl/2012/main" name="Office Theme" id="{62F939B6-93AF-4DB8-9C6B-D6C7DFDC589F}" vid="{4A3C46E8-61CC-4603-A589-7422A47A8E4A}"/></a:ext></a:extLst>',
  '<p:extLst><p:ext uri="{D42A27DB-BD31-4B8C-83A1-F6EECF244321}"><p14:modId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="1579011935"/></p:ext></p:extLst>',
  '<p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="1024086991"/></p:ext></p:extLst>',
];
/** Accept only a projection of the authorized saved revision and verified processed
 * renditions. Authorization/final revocation checks remain with withIllustratedStudy.
 * Text and tables are native editable objects; there is no original image, URL,
 * clinic identity or patient-name parameter. Case-only labels are not anonymization. */
export async function renderFullStudyPptx(value: FullStudyPresentation): Promise<Uint8Array> {
  value = structuredClone(value);
  validateFullStudyPresentation(value);
  const notes = checkedStudyPageNotes(value.pages.map(page => fullStudyPageNotes(value, page)));
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'ORTHO_SAVED_FULL', width: CASE_PAGE.width, height: CASE_PAGE.height });
  pptx.layout = 'ORTHO_SAVED_FULL'; pptx.author = 'Clinical case renderer'; pptx.subject = FULL_STUDY_RENDERER;
  pptx.title = `Ortho case ${value.caseId} — revision ${value.version}`; pptx.rtlMode = true;
  const base = { fontFace: CASE_PAGE.fontFace, rtlMode: true, lang: 'ar-SA', align: 'right' as const, margin: 0,
    color: '182B3A', breakLine: false, paraSpaceAfterPt: 0, valign: 'top' as const };
  for (const [index, page] of value.pages.entries()) {
    const slide = pptx.addSlide(); slide.background = { color: 'FFFFFF' };
    slide.addText(page.title, { ...base, x: .4, y: .15, w: 9.2, h: .42, fontSize: 20, bold: true, color: '17324D' });
    slide.addText(`نسخة سريرية • الحالة ${value.caseId} • الإصدار ${value.version} • ${value.kind === 'draft' ? 'مسودة' : 'نسخة موثقة'}${page.modelAnalysisId ? ' • حساب غير معتمد سريريًا' : ''}`,
      { ...base, x: .4, y: .65, w: 9.2, h: .28, fontSize: 12, color: '526579' });
    for (const element of page.elements) {
      if (element.kind === 'text') slide.addText(isolateStudyDateTokens(element.text), {
        ...base, ...element.rect, fontSize: element.fontSize, lineSpacingMultiple: 1.0,
      });
      else if (element.kind === 'image') slide.addImage({
        ...element.rect, data: `image/png;base64,${Buffer.from(element.image.png).toString('base64')}`,
        altText: `Saved image use ${element.image.use.useId}`,
      });
      else {
        slide.addText(element.caption, { ...base, x: element.rect.x, y: element.rect.y, w: element.rect.w, h: element.captionHeight, fontSize: 12, bold: true, color: '526579' });
        slide.addTable([
        element.headers.map(text => ({ text: isolateStudyDateTokens(text), options: { bold: true, color: '17324D', fill: { color: 'EAF0F5' } } })),
        ...element.rows.map(row => row.map(text => ({ text: isolateStudyDateTokens(text) }))),
      ], { ...base, ...element.rect, y: element.rect.y + element.captionHeight, h: element.headerHeight + element.rowHeights.reduce((sum, height) => sum + height, 0),
        fontSize: element.fontSize, colW: [...element.columnWidths], rowH: [element.headerHeight, ...element.rowHeights],
        autoPage: false, margin: [.02, .025, .02, .025], border: { color: 'B8C5D0', pt: .5 },
        });
      }
    }
    slide.addText('نسخة سريرية؛ النص والصور قد يحددان الهوية. ليست للنشر التعليمي.',
      { ...base, x: .4, y: 6.97, w: 9.2, h: .22, fontSize: 10, color: '526579' });
    slide.addText(`${index + 1}/${value.pages.length} • ${value.revisionHash.slice(0, 16)} • ${FULL_STUDY_RENDERER}`,
      { ...base, x: .4, y: 7.23, w: 9.2, h: .18, fontSize: 8, color: '526579', rtlMode: false, align: 'left' });
    slide.addNotes(notes[index]);
  }
  // All objects/bytes are consumed before the first await. The caller's mutable
  // projection cannot replace a selected image or source while packaging runs.
  const captureTime = value.capturedAt, pageCount = value.pages.length;
  const expectedImages = new Set(value.pages.flatMap(page => page.elements.flatMap(element => element.kind === 'image' ? [element.image.renditionSha256] : [])));
  const raw = new Uint8Array(await pptx.write({ outputType: 'arraybuffer', compression: true }) as ArrayBuffer);
  if (raw.byteLength > FULL_STUDY_LIMITS.outputBytes) fail('output_limit');
  const parts = inspectCasePackage(raw, true);
  if (parts.filter(part => /^ppt\/slides\/slide\d+\.xml$/.test(part.name)).length !== pageCount) fail('unexpected_slides');
  const actualImages = new Set<string>();
  const names = new Set(parts.map(part => part.name));
  for (const part of parts) {
    if (part.name.endsWith('.png')) {
      const hash = hashBytes(part.bytes); if (!expectedImages.has(hash)) fail('unexpected_image'); actualImages.add(hash); continue;
    }
    let xml = part.bytes.toString('utf8');
    if (Buffer.from(xml).compare(part.bytes) !== 0) fail('package_encoding');
    for (const extension of generatedMetadataExtensions) xml = xml.replaceAll(extension, '');
    part.bytes = Buffer.from(xml);
    if ( /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<(?:[A-Za-z_][\w.-]*:)?(?:script|oleObj|videoFile|audioFile|snd|hlinkClick|hlinkMouseOver|custData|extLst)\b/i.test(xml)
      || /<p:sld\s[^>]*\bshow="0"/.test(xml)) fail('active_package_content');
    if (!part.name.endsWith('.rels')) continue;
    for (const rel of xml.matchAll(/<Relationship\s+([^>]+)\/?\s*>/g)) {
      const attributes = rel[1], target = /\bTarget="([^"]+)"/.exec(attributes)?.[1];
      if (/TargetMode\s*=\s*["']External/i.test(attributes) || !target || /[&\\:#?]/.test(target) || target.includes('\0') || target.startsWith('/')) fail('external_relationship');
      const basePath = part.name === '_rels/.rels' ? [] : part.name.split('/').slice(0, -2);
      for (const item of target.split('/')) {
        if (item === '..') { if (!basePath.length) fail('package_relationship'); basePath.pop(); }
        else if (item !== '.') basePath.push(item);
      }
      if (!names.has(basePath.join('/'))) fail('package_relationship');
    }
  }
  if (actualImages.size !== expectedImages.size) fail('missing_image');
  // Keep authored provenance notes. The older package normalizer intentionally
  // strips all notes, so this generated-only path normalizes metadata separately.
  const core = parts.find(part => part.name === 'docProps/core.xml'); if (!core) fail('package_metadata');
  core.bytes = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Clinical case renderer</dc:creator><cp:lastModifiedBy>Clinical case renderer</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' + captureTime + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + captureTime + '</dcterms:modified></cp:coreProperties>');
  const zip = new JSZip();
  for (const part of parts) zip.file(part.name, part.bytes, { date: new Date('2000-01-01T00:00:00.000Z'), createFolders: false });
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (bytes.byteLength > FULL_STUDY_LIMITS.outputBytes) fail('output_limit');
  inspectCasePackage(bytes, true);
  return bytes;
}
