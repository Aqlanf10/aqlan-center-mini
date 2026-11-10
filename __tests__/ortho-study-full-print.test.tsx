import { describe, expect, it } from 'vitest';
import { ALL_SETTING_KEYS, type SettingsMap } from '../lib/settings';
const syntheticSettings = Object.fromEntries(ALL_SETTING_KEYS.map(key => [key, ''])) as SettingsMap;
import { hashBytes } from '../lib/ortho-case-render-security';
import { renderToStaticMarkup } from 'react-dom/server';
import { CASE_LAYOUTS } from '../lib/ortho-case-template';
import { fullStudyPresentation, fullStudyProjectionHash, fullStudyTablePages, FULL_STUDY_BODY } from '../lib/ortho-study-full-layout';
import { illustrateSavedStudy } from '../lib/ortho-study-illustrated';
import { prepareFullStudyPrint, validateFullStudyPrint, FULL_STUDY_PRINT } from '../lib/ortho-study-full-print';
import { OrthoFullStudyPrintPages } from '../components/OrthoFullStudyPrintPages';
import { full, imageFixture, modelSaved } from './fixtures/ortho-full-study-print';

describe('separate browser print adapter for the verified full projection',()=>{
  it('retains all27 layouts, repeated visits, one capture prefix and source order without changing PPTX projection',async()=>{
    const original=await full([...CASE_LAYOUTS.map(layout=>layout.key),'visit']), before=structuredClone(original);
    const printed=prepareFullStudyPrint(original);
    expect(original).toEqual(before); expect(printed.sourceProjectionHash).toBe(original.projectionHash);
    expect([...new Set(printed.sheets.map(sheet=>sheet.sourcePageIndex))]).toEqual(original.pages.map((_,index)=>index));
    expect(printed.sheets.filter(sheet=>sheet.title==='سياق التقاط الدراسة المحفوظة')).toHaveLength(1);
    expect(printed.sheets.filter(sheet=>sheet.title.includes('زيارة')).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(printed)).not.toMatch(/modelAnalyses|exactWitness|patientName/);
    expect(printed.sheets.flatMap(sheet=>sheet.elements).filter(element=>element.kind==='text').map(element=>element.text).join('')).toContain('غير مسجل');
    validateFullStudyPrint(printed);
    original.pages[0].title='CHANGED_AFTER_PREPARATION'; expect(JSON.stringify(printed)).not.toContain('CHANGED_AFTER_PREPARATION');
  });
  it('reconstructs every cell and original source row/field/fragment after longer print continuation',async()=>{
    const original=await full(['interview']);
    const headers=Array.from({length:12},(_,i)=>`الحقل ${i}`), rows=Array.from({length:2},(_,row)=>headers.map((_,col)=>col===10 ? `source${row}col${col} `+'LONG'.repeat(1100):`row${row}col${col} 2.5 mm`));
    const tables=fullStudyTablePages(headers,rows,FULL_STUDY_BODY,[]);
    original.pages=tables.map((table,index)=>({...original.pages[1], title:`Synthetic table ${index}`, elements:[table]}));
    original.projectionHash=fullStudyProjectionHash(original);
    const printed=prepareFullStudyPrint(original);
    for(const [pageIndex,page] of original.pages.entries()) {
      const source=page.elements[0]; if(source.kind!=='table')throw Error('Expected table');
      const children=printed.sheets.filter(sheet=>sheet.sourcePageIndex===pageIndex).flatMap(sheet=>sheet.elements);
      for(const [rowIndex,row] of source.rows.entries()) {
        const reconstructed=row.map(()=>[] as string[]);
        for(const child of children){if(child.kind!=='table')throw Error('Expected native table');
          child.rows.forEach((cells,index)=>{const mapping=child.fragments[index]; if(mapping.sourceRowIndex!==rowIndex)return;
            expect(mapping.sourceFragment).toEqual(source.fragments[rowIndex]);
            if (source.projection === 'row_fields' && mapping.printFragmentIndex > 0 && !cells[0]) expect(child.continuationLabels[index]).toBe(source.rows[rowIndex][0]);
            cells.forEach((cell,col)=>reconstructed[col].push(cell));
          });
        }
        // Repeated field labels are presentation context, never duplicated events.
        reconstructed.forEach((pieces,col)=>expect(pieces.join('\n').replaceAll('\n','')).toBe(row[col].replaceAll('\n','')));
      }
    }
    expect(printed.sheets.length).toBeGreaterThan(original.pages.length);
    expect(printed.sheets.every(sheet=>sheet.continuation>0&&sheet.continuation<=sheet.continuationCount)).toBe(true);
  });
  it('retains only verified cropped PNGs and filtered image provenance, without original/private-source leakage',async()=>{
    const { full: original, bytes } = await imageFixture(); const printed=prepareFullStudyPrint(original);
    const images=printed.sheets.flatMap(sheet=>sheet.elements).filter(element=>element.kind==='image');
    expect(images).toHaveLength(2);
    for(const image of images) {
      const png=Buffer.from(image.dataUrl.split(',')[1],'base64');
      expect(hashBytes(png)).toBe(image.renditionSha256);expect(hashBytes(png)).not.toBe(hashBytes(bytes));
      expect(image.w/image.h).toBeCloseTo(image.width/image.height,8);
      expect(image.x).toBeGreaterThanOrEqual(0);expect(image.y).toBeGreaterThanOrEqual(0);
      expect(image.y+image.h).toBeLessThanOrEqual(FULL_STUDY_PRINT.bodyHeight+.001);
    }
    expect(JSON.stringify(printed)).not.toMatch(/EXCLUDED_PRIVATE|cropPpm|originalUrl/);
    expect(printed.sheets.filter(sheet=>sheet.purpose==='image-provenance').length).toBeGreaterThan(0);
    const html=renderToStaticMarkup(<OrthoFullStudyPrintPages value={printed} settings={syntheticSettings} />);
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(2);
    expect(html).not.toMatch(/EXCLUDED_PRIVATE|modelAnalyses|exactWitness/);
    for (const image of images) { expect(html).toContain(image.sourceSha256); expect(html).toContain(image.renditionSha256); }
  });
  it('keeps model notes server-side, accounts duplicated note bytes, and refuses aggregate4MiB',async()=>{
    const revision=modelSaved(), modelScope={patientId:revision.patientId,orthoCaseId:revision.orthoCaseId,clinicalCaseId:revision.clinicalCaseId};
    const original=await fullStudyPresentation(revision,modelScope,await illustrateSavedStudy(revision,modelScope,async()=>{throw Error('No images');}));
    const printed=prepareFullStudyPrint(original);expect(printed.notesBytes).toBeGreaterThan(10000);
    expect(JSON.stringify(printed)).not.toMatch(/exactWitness|dependencyObservationIds|measurementSet/);
    const html=renderToStaticMarkup(<OrthoFullStudyPrintPages value={printed} settings={syntheticSettings} />);
    expect(html).toContain('حساب غير معتمد سريريًا');expect(html).not.toMatch(/exactWitness|dependencyObservationIds|measurementSet/);
    const evidence=original.pages.find(page=>page.modelAnalyses?.length)!;
    evidence.elements=[{kind:'text',rect:{...FULL_STUDY_BODY},text:'Synthetic notes budget',fontSize:14}];
    original.pages=Array.from({length:300},()=>structuredClone(evidence));original.projectionHash=fullStudyProjectionHash(original);
    expect(()=>prepareFullStudyPrint(original)).toThrow('study_presentation_notes_limit');
  },30000);
  it('refuses changed projection or sheet limit rather than truncating',async()=>{
    const original=await full();original.pages[0].title='tampered';expect(()=>prepareFullStudyPrint(original)).toThrow('full_study_projection_changed');
    const many=await full(['interview']);
    const source=many.pages[0]; source.elements=[{kind:'text',rect:{...FULL_STUDY_BODY},text:Array.from({length:18},()=> 'line').join('\n'),fontSize:14}];
    many.pages=Array.from({length:300},()=>structuredClone(source));many.projectionHash=fullStudyProjectionHash(many);
    expect(()=>prepareFullStudyPrint(many)).toThrow('study_full_print_sheet_limit');
  });
  it('keeps full clinic identity, exact date/source footer, native tables and fail-closed direct-print CSS',async()=>{
    const original=await full(['interview']);
    original.pages[1].elements=fullStudyTablePages(['الحقل','القيمة'],[['مسافة','-2.5 mm']],FULL_STUDY_BODY,[]);
    original.projectionHash=fullStudyProjectionHash(original);
    const value=prepareFullStudyPrint(original),html=renderToStaticMarkup(<OrthoFullStudyPrintPages value={value} settings={{...syntheticSettings,'clinic.name':'Synthetic center','clinic.lead_doctor':'Synthetic doctor','clinic.lead_doctor_title':'Synthetic specialty','clinic.lead_doctor_credentials':'LONG CREDENTIAL '.repeat(18)}} />);
    expect(html).toContain('Synthetic center');expect(html).toContain('Synthetic doctor');expect(html).toContain('Synthetic specialty');expect(html).toContain('LONG CREDENTIAL '.repeat(18));
    expect(html).toContain('<table');expect(html).toContain('-2.5 mm');expect(html).toContain('مسودة');expect(html).toContain('data-print-ready="false"');expect(html).toContain('disabled=""');
    expect(html).toContain(':not([data-print-ready="true"]) .full-print-sheets { display:none!important; }');
    expect(html).toContain('data-study-captured-at');expect(html).toContain(value.capturedAt);expect(html).toContain(value.revisionHash);
    expect(html).not.toMatch(/exactWitness|measurementSet|overflow:\s*hidden/);
    expect(FULL_STUDY_PRINT.bodyHeight).toBe(112);expect(FULL_STUDY_PRINT.height).toBe(190);
  });
});
