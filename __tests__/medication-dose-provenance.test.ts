import {createHash} from 'node:crypto';
import { expect,it } from 'vitest';
import { DOSE_REFERENCE_VERSION } from '../lib/medication-dose-profiles';
import { parseDoseReviewInput,type DoseReviewInput } from '../lib/medication-dose-review';
import { createCalculatedDoseProvenance,calculatedDoseFields,medicationDoseProvenanceProblem,parseMedicationDoseProvenance,canonicalMedicationDoseProvenance } from '../lib/medication-dose-provenance';
import { changedMedicationSelection,manualMedicationSelectionError } from '../lib/prescription-medication-selection';
import { prescriptionDraftPrintItems,sanitizeRxItem,type PrescriptionDraft,type RxItem } from '../lib/prescription';
import { canonicalPrescriptionCommand } from '../lib/prescription-command';
import { canonicalPrescriptionForAck } from '../lib/prescription-safety-ack';
const input=():DoseReviewInput=>({profileId:'amoxicillin-child-aapd-q8',referenceVersion:DOSE_REFERENCE_VERSION,indication:'Synthetic reviewed indication',ageMonths:60,ageVerified:true,weightKg:20,currentWeightVerified:true,selectedDose:30,administrationsPer24h:3,scheduleKind:'fixed-interval',intervalHours:8,durationDays:5,reviewPlan:'Review synthetic patient',product:{name:'Synthetic suspension',ingredientId:'amoxicillin',formulation:'single-ingredient',labelUrl:'https://synthetic.invalid/label',kind:'oral-liquid',strengthMg:250,perMl:5,measurementIncrementMl:0.1,minimumAgeMonths:4,labelVerified:true},otherSameIngredientMg24h:0,specialPopulationOrInteraction:false,antibioticIndicationReviewed:true});
function row():RxItem {const doseReview=createCalculatedDoseProvenance(input())!;const {amount,...fields}=calculatedDoseFields(doseReview)!;return {...fields,selection:{id:'amoxicillin',amount,confirmed:true,doseReview}};}
function draft(item:RxItem):PrescriptionDraft {return {patientId:1,visitId:2,diagnosis:'Synthetic',notes:'',instructionsLang:'both',items:[item],prescribingDoctorPartyId:3,prescribingDoctorName:'Synthetic doctor'};}
it('persists full clinical calculation inputs/results rather than only a client hash',()=>{const item=row(),clean=sanitizeRxItem(item)!;expect(manualMedicationSelectionError([clean])).toBeNull();expect(clean.selection!.doseReview).toMatchObject({mode:'calculated',input:{ageMonths:60,weightKg:20,product:{strengthMg:250,perMl:5}},result:{mgPerDose:200,mlPerDose:4,mgPer24h:600}});input().weightKg=1;expect(clean.selection!.doseReview).toEqual(item.selection!.doseReview);});
it('strictly rejects unknown or unbounded transport fields',()=>{expect(parseDoseReviewInput({...input(),admin:true})).toBeNull();expect(parseDoseReviewInput({...input(),product:{...input().product,density:1}})).toBeNull();expect(parseDoseReviewInput({...input(),indication:'x'.repeat(501)})).toBeNull();expect(parseDoseReviewInput({...input(),weightKg:'20'})).toBeNull();expect(parseMedicationDoseProvenance({...row().selection!.doseReview,approved:true})).toBeNull();});
it('recomputes claimed result and refuses tampering without trusting browser fingerprint',()=>{const item=row();const p=item.selection!.doseReview!;if(p.mode!=='calculated')throw Error();p.result.mgPerDose=999;expect(medicationDoseProvenanceProblem(p,item as unknown as Record<string,unknown>)).toContain('إعادة التحقق');});
it('rejects mismatching actual dose, concentration, frequency, instructions or generic choice',()=>{for(const key of ['dose','frequency','duration','instructions','name'] as const){const item=row();item[key]='tampered';expect(medicationDoseProvenanceProblem(item.selection!.doseReview,item as unknown as Record<string,unknown>)).toContain('تغيرت');}const item=row();item.selection!.amount='99mL';expect(medicationDoseProvenanceProblem(item.selection!.doseReview,item as unknown as Record<string,unknown>)).toContain('تغيرت');});
it('manual changes explicitly retire calculation proof and require renewed confirmation',()=>{const item=row();item.selection=changedMedicationSelection(item.selection!);item.frequency='Manual reviewed schedule';expect(item.selection.doseReview).toMatchObject({mode:'reference-only'});expect(item.selection.doseReview).not.toHaveProperty('input');expect(manualMedicationSelectionError([item])).toContain('أكّد');item.selection.confirmed=true;expect(manualMedicationSelectionError([item])).toBeNull();});
it('every retained input binds command and acknowledgement even when numerical result is unchanged',()=>{const a=row(),b=row();const p=b.selection!.doseReview!;if(p.mode!=='calculated')throw Error();p.input.product.name='Another verified label';expect(canonicalPrescriptionCommand(draft(a))).not.toBe(canonicalPrescriptionCommand(draft(b)));expect(canonicalPrescriptionForAck(draft(a))).not.toBe(canonicalPrescriptionForAck(draft(b)));});
it('shape normalization binds identical key permutations identically',()=>{const p=row().selection!.doseReview!;expect(canonicalMedicationDoseProvenance(Object.fromEntries(Object.entries(p).reverse()) as typeof p)).toBe(canonicalMedicationDoseProvenance(p));});
it('saved snapshots remain readable without reauthorization against a new reference version',()=>{const item=row();item.selection!.doseReview!.referenceVersion='historical-reference-version';expect(sanitizeRxItem(item)?.selection?.doseReview?.referenceVersion).toBe('historical-reference-version');expect(manualMedicationSelectionError([item])).toBeNull();expect(medicationDoseProvenanceProblem(item.selection!.doseReview,item as unknown as Record<string,unknown>)).toContain('نسخته');});
it('non-profile canonical command bytes remain exactly unchanged',()=>{const item=row();delete item.selection!.doseReview;const d=draft(item);const old=JSON.stringify({version:1,patientId:d.patientId,visitId:d.visitId,prescribingDoctorPartyId:d.prescribingDoctorPartyId,diagnosis:d.diagnosis,notes:d.notes,instructionsLang:d.instructionsLang,items:d.items.map(i=>[i.name,i.dose,i.form,i.frequency,i.duration,i.instructions,i.instructionsEn,i.selection?.id??null,i.selection?.amount??null,i.selection?.confirmed??null])});expect(canonicalPrescriptionCommand(d)).toBe(old);});

it('does not serialize age, weight or product-label snapshot into draft print query items',()=>{const item=row(),printed=prescriptionDraftPrintItems([item]);expect(printed[0].selection).not.toHaveProperty('doseReview');const query=JSON.stringify(printed);expect(query).not.toContain('weightKg');expect(query).not.toContain('synthetic.invalid');expect(item.selection).toHaveProperty('doseReview');expect(printed[0].selection?.confirmed).toBe(true);});

it('preserves published fab4 v1 snapshot, command and acknowledgement golden bytes',()=>{
 const item=row();
 // Published golden bytes describe the historical reference, not today's new issuance.
 const historical=item.selection!.doseReview!;
 if(historical.mode!=='calculated')throw Error();
 historical.referenceVersion='2026-11-01.expansion.1';
 historical.input.referenceVersion='2026-11-01.expansion.1';
 const d=draft(item),sha=(value:string)=>createHash('sha256').update(value).digest('hex');
 expect(parseMedicationDoseProvenance(historical)).not.toBeNull();
 expect(medicationDoseProvenanceProblem(historical,item as unknown as Record<string,unknown>)).toBeNull();
 expect(sha(canonicalMedicationDoseProvenance(item.selection!.doseReview!))).toBe('f425549035e9ebc2e6405aff9a0da6759fa5adab7353e54714d584497336f6c2');
 expect(sha(canonicalPrescriptionCommand(d))).toBe('6ef7fba16f8a8ce79baf4b443a676e7cd9d6df93d61eead9e1a8743c0228a1bc');
 expect(sha(canonicalPrescriptionForAck(d))).toBe('1054fb29ca9810503e08f979044798fe80f79c58f6ff3d111f56ed1a239d30c5');
});
