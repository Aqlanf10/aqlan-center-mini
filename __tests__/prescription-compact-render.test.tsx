import { expect,it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrescriptionModal } from '../components/PrescriptionModal';
it('renders a blank writable medicine and closed optional resources without hiding patient warnings',()=>{
 const html=renderToStaticMarkup(<PrescriptionModal isOpen onClose={()=>{}} patientId={123} patientName="Synthetic patient" medicalAlert="Synthetic allergy alert" patientContextStatus="unavailable"/>);
 expect(html).toContain('Synthetic allergy alert');
 expect(html).toContain('حالة الحساسية والمخاطر غير معروفة');
 expect(html).toContain('اسم الدواء للسطر 1');
 expect(html).toContain('القوة / التركيز والوحدة');
 expect(html).toContain('مقدار الجرعة للسطر 1');
 expect(html).toContain('حفظ وطباعة الوصفة');
 expect(html.indexOf('اسم الدواء للسطر 1')).toBeLessThan(html.indexOf('data-prescription-optional="references"'));
 for(const tag of html.match(/<details[^>]*>/g)??[])expect(tag).not.toMatch(/\sopen(?:=|\s|>)/);
 expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
 expect(html).toMatch(/<input[^>]*placeholder="Drug name"[^>]*value=""/);
});
it('does not render a closed dialog',()=>{expect(renderToStaticMarkup(<PrescriptionModal isOpen={false} onClose={()=>{}} patientName="Synthetic"/>)).toBe('');});

import {PrescriptionStaleReferenceNotice} from '../components/PrescriptionStaleReferenceNotice';
import {blankPrescriptionRow,retireDraftDoseReference} from '../lib/prescription-draft-rows';
import {DOSE_REFERENCE_VERSION} from '../lib/medication-dose-profiles';
it('renders stale-source recovery and its actual action keeps text but requires renewed review',()=>{
 let row={...blankPrescriptionRow(),name:'Synthetic authored medicine',instructions:'Keep these instructions',selection:{id:'manual' as const,amount:'Authored amount',confirmed:true,doseReview:{version:1 as const,mode:'reference-only' as const,profileId:'amoxicillin-sdcep',referenceVersion:'2026-11-01.expansion.1'}}} as import('../lib/prescription').RxItem;
 const element=PrescriptionStaleReferenceNotice({item:row,onRetire:()=>{row=retireDraftDoseReference(row);}})!;
 const html=renderToStaticMarkup(element);expect(html).toContain('تغير إصدار المرجع');expect(html).toContain('الاحتفاظ بالنص');
 const action=element.props.children[1];action.props.onClick();expect(row.name).toBe('Synthetic authored medicine');expect(row.instructions).toBe('Keep these instructions');expect(row.selection).toEqual({id:'manual',amount:'Authored amount',confirmed:false});expect(PrescriptionStaleReferenceNotice({item:row,onRetire:()=>{}})).toBeNull();
 const current={...row,selection:{...row.selection!,doseReview:{version:1 as const,mode:'reference-only' as const,profileId:'amoxicillin-sdcep',referenceVersion:DOSE_REFERENCE_VERSION}}};expect(PrescriptionStaleReferenceNotice({item:current,onRetire:()=>{}})).toBeNull();
});
