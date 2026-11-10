import { PrintHeader } from './PrintHeader';
import { OrthoFullStudyPrintReadiness } from './OrthoFullStudyPrintReadiness';
import type { SettingsMap } from '@/lib/settings';
import { isolateStudyDateTokens } from '@/lib/ortho-study-display';
import { FULL_STUDY_PRINT as G, validateFullStudyPrint, type FullStudyPrintPresentation } from '@/lib/ortho-study-full-print';

export function OrthoFullStudyPrintPages({ value, settings }: { value: FullStudyPrintPresentation; settings: SettingsMap }) {
  validateFullStudyPrint(value);
  return <main dir="rtl" data-full-study-print data-print-ready="false" className="full-study-print">
    <style>{`
.full-study-print { color:#182b3a; background:white; font-family:Arial,sans-serif; }
.full-study-print * { box-sizing:border-box; }
.full-study-print .study-print-controls { padding:12px; }
.full-study-print .study-print-not-ready { padding:12px; color:#7f1d1d; }
.full-study-print[data-print-ready="true"] .study-print-not-ready { display:none; }
.full-study-print .full-print-sheet { position:relative; width:${G.width}mm; height:${G.height}mm; margin:12px auto; background:white; }
.full-study-print [data-print-region] { position:absolute; width:100%; margin:0; padding:0; }
.full-study-print .full-print-header { top:0; height:${G.headerHeight}mm; }
.full-study-print .full-print-meta { top:${G.metaTop}mm; height:${G.metaHeight}mm; font-size:10pt; line-height:1.4; }
.full-study-print .full-print-body { top:${G.bodyTop}mm; right:${(G.width - G.bodyWidth) / 2}mm; width:${G.bodyWidth}mm; height:${G.bodyHeight}mm; }
.full-study-print .full-print-footer { top:${G.footerTop}mm; height:${G.footerHeight}mm; font-size:8pt; line-height:1.4; border-top:1px solid #b8c5d0; }
.full-study-print p { margin:0; }
.full-study-print .full-print-text { font-size:14pt; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.full-study-print .full-print-caption { font-size:12pt; line-height:1.5; font-weight:bold; white-space:pre-wrap; }
.full-study-print table { width:100%; table-layout:fixed; border-collapse:collapse; font-size:12pt; line-height:1.5; }
.full-study-print th,.full-study-print td { border:.5pt solid #b8c5d0; padding:.5mm .635mm; vertical-align:top; text-align:right; white-space:pre-wrap; overflow-wrap:anywhere; }
.full-study-print th { background:#eaf0f5; font-weight:bold; }
.full-study-print .full-print-hash { direction:ltr; unicode-bidi:isolate; overflow-wrap:anywhere; }
@media print {
 @page ortho-full-study { size:A4 landscape; margin:${G.margin}mm; }
 .full-study-print .study-print-controls { display:none!important; }
 .full-study-print:not([data-print-ready="true"]) .full-print-sheets { display:none!important; }
 .full-study-print:not([data-print-ready="true"]) .study-print-not-ready { display:block!important; }
 .full-study-print .full-print-sheet { page:ortho-full-study; margin:0 auto; break-after:page; break-inside:avoid; }
 .full-study-print .full-print-sheet:last-child { break-after:auto; }
}
`}</style>
    <div className="study-print-controls"><h1>دراسة الحالة — نسخة سريرية مصورة</h1><p>قد تزيد أوراق الطباعة عن شرائح العرض لحفظ الترويسة ووضوح المحتوى. النص والصور قد يحددان الهوية؛ هذه النسخة ليست مجهولة الهوية وليست للنشر التعليمي.</p></div>
    <OrthoFullStudyPrintReadiness />
    <div className="full-print-sheets">{value.sheets.map((sheet, index) => <section key={index} data-print-sheet data-source-page={sheet.sourcePageIndex + 1} className="full-print-sheet">
      <div data-print-region="header" className="full-print-header"><div data-print-content><PrintHeader settings={settings} title={`${sheet.title}${sheet.continuationCount > 1 ? ` — جزء الطباعة ${sheet.continuation} من ${sheet.continuationCount}` : ''}`} compact strictIdentity /></div></div>
      <div data-print-region="meta" className="full-print-meta"><p data-print-content>الحالة {value.caseId} · الإصدار {value.version} · {value.kind === 'draft' ? 'مسودة' : 'نسخة موثقة'}{sheet.modelUnapproved ? ' · حساب غير معتمد سريريًا' : ''}</p></div>
      <div data-print-region="body" className="full-print-body">{sheet.elements.map((element, elementIndex) => {
        if (element.kind === 'text') return <p key={elementIndex} data-print-content className="full-print-text" dir="auto">{isolateStudyDateTokens(element.text) || '\u00a0'}</p>;
        if (element.kind === 'image') return <img key={elementIndex} data-print-content className="print-watermark-protected" src={element.dataUrl} width={element.width} height={element.height} alt={`صورة محفوظة ${element.useId}`} style={{ position:'absolute', left:`${element.x}mm`, top:`${element.y}mm`, width:`${element.w}mm`, height:`${element.h}mm`, objectFit:'contain' }} />;
        return <div key={elementIndex} data-print-content>
          <p data-print-content className="full-print-caption" style={{ height:`${element.captionHeight}mm` }}>{element.caption}</p>
          <table data-print-content><colgroup>{element.columnWidths.map((width, col) => <col key={col} style={{ width:`${width}mm` }} />)}</colgroup>
            <thead><tr style={{ height:`${element.headerHeight}mm` }}>{element.headers.map((header, col) => <th key={col} scope="col">{isolateStudyDateTokens(header)}</th>)}</tr></thead>
            <tbody>{element.rows.map((row, rowIndex) => <tr key={rowIndex} data-source-row={element.fragments[rowIndex].sourceFragment.rowIndex + 1} style={{ height:`${element.rowHeights[rowIndex]}mm` }}>{row.map((cell, col) => <td key={col}>{col === 0 && element.continuationLabels[rowIndex] ? <span>متابعة الحقل: {isolateStudyDateTokens(element.continuationLabels[rowIndex]!)}</span> : isolateStudyDateTokens(cell) || '\u00a0'}</td>)}</tr>)}</tbody>
          </table>
        </div>;
      })}</div>
      <footer data-print-region="footer" className="full-print-footer"><div data-print-content>
        <p>ورقة <bdi dir="ltr">{index + 1} / {value.sheets.length}</bdi> · صفحة العرض المصدر {sheet.sourcePageIndex + 1} · محفوظة في <bdi dir="ltr" data-study-captured-at>{value.capturedAt}</bdi></p>
        <p>المراجع: {sheet.sourceKeys.join('، ') || 'لا توجد مراجع مختارة'}</p>
        <p className="full-print-hash">SHA256: {value.revisionHash}</p>
        <p>نسخة سريرية؛ النص والصور قد يحددان الهوية. ليست للنشر التعليمي.</p>
      </div></footer>
    </section>)}</div>
  </main>;
}
