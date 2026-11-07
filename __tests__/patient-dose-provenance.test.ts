import {describe,it,expect} from 'vitest';
import fixtures from './legacy-dose-issued-fixtures.json';
import * as patient from '../lib/patient-dose-provenance';
import * as legacy from '../lib/medication-dose-provenance';
import {DOSE_REFERENCE_VERSION,doseReference} from '../lib/medication-dose-profiles';
import {sanitizeRxItem,type RxItem,type PrescriptionDraft} from '../lib/prescription';
import {changedMedicationSelection,manualMedicationSelectionError} from '../lib/prescription-medication-selection';
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
function example(f:typeof fixtures.rows[number]) {
 const old=legacy.parseMedicationDoseProvenance(f.row.selection.doseReview)!;
 if(old.mode!=='calculated')throw Error();
 const input={...old.input,referenceVersion:DOSE_REFERENCE_VERSION};
 const p=patient.createCalculatedDoseProvenance(input)!;
 const {amount,...fields}=patient.calculatedDoseFields(p)!;
 const row:RxItem={...fields,selection:{id:f.row.selection.id as NonNullable<RxItem['selection']>['id'],confirmed:true,amount,doseReview:p}};
 return {p,row};
}
describe('v3 patient-facing projection with immutable legacy semantics',()=>{
 it.each(fixtures.rows)('$profileId transfers patient advice without clinician reference notes',f=>{
  const {p,row}=example(f);expect(p.version).toBe(3);
  expect(row.instructions).toContain('خطة المراجعة:');
  expect(row.instructions).not.toContain(doseReference(p.profileId)!.notes);
  expect(patient.medicationDoseProvenanceProblem(p,row as unknown as Record<string,unknown>)).toBeNull();
  expect(sanitizeRxItem(row)).toEqual(row);expect(manualMedicationSelectionError([row])).toBeNull();
  expect(patient.parseMedicationDoseProvenance(p)).toEqual(p);
 });
 it.each(fixtures.rows)('retains old $profileId canonical and exact projection',f=>{
  const p=legacy.parseMedicationDoseProvenance(f.row.selection.doseReview)!;
  expect(patient.calculatedDoseFields(p)).toEqual(legacy.calculatedDoseFields(p));
  expect(patient.canonicalMedicationDoseProvenance(p)).toBe(legacy.canonicalMedicationDoseProvenance(p));
 });
 it('rejects any projected field, amount, ingredient or calculated result tampering',()=>{
  for(const key of ['name','dose','form','frequency','duration','instructions','instructionsEn','amount','id','result']){
   const {p,row}=example(fixtures.rows[0]);
   if(key==='amount')row.selection!.amount='tampered';
   else if(key==='id')row.selection!.id='manual';
   else if(key==='result'&&p.mode==='calculated')p.result.mgPerDose+=1;
   else (row as unknown as Record<string,unknown>)[key]='tampered';
   expect(patient.medicationDoseProvenanceProblem(p,row as unknown as Record<string,unknown>)).toBeTruthy();
  }
 });
 it('rejects old/unknown references, nested mismatches, unknown fields and wrong input schema',()=>{
  const {p,row}=example(fixtures.rows[0]);
  expect(patient.parseMedicationDoseProvenance({...p,inputVersion:9})).toBeNull();
  expect(patient.parseMedicationDoseProvenance({...p,extra:true})).toBeNull();
  if(p.mode!=='calculated'||p.version!==3)throw Error();
  expect(patient.parseMedicationDoseProvenance({...p,inputVersion:p.inputVersion===1?2:1})).toBeNull();
  for(const version of ['2026-11-01.expansion.1','unknown'])expect(patient.medicationDoseProvenanceProblem({...p,referenceVersion:version},row as unknown as Record<string,unknown>)).toBeTruthy();
  expect(patient.medicationDoseProvenanceProblem({...p,input:{...p.input,referenceVersion:'unknown'}},row as unknown as Record<string,unknown>)).toBeTruthy();
 });
 it('manual editing preserves authored text and retires proof until reconfirmation',()=>{
  const {row}=example(fixtures.rows[0]);row.instructions='Clinician authored patient warning';
  row.selection=changedMedicationSelection(row.selection!);
  expect(row.selection.doseReview).toMatchObject({version:3,mode:'reference-only'});
  expect(row.selection.doseReview).not.toHaveProperty('inputVersion');
  expect(manualMedicationSelectionError([row])).toBeTruthy();
  row.selection.confirmed=true;expect(manualMedicationSelectionError([row])).toBeNull();
  expect(sanitizeRxItem(row)?.instructions).toBe('Clinician authored patient warning');
 });
 it('canonical output is deterministic across transport key order',()=>{
  const {p}=example(fixtures.rows[0]);expect(patient.canonicalMedicationDoseProvenance(Object.fromEntries(Object.entries(p).reverse()) as typeof p)).toBe(patient.canonicalMedicationDoseProvenance(p));
 });
});
it('classification is pinned to six reviewed notes and source version, never future note stripping',()=>{
 for(const f of fixtures.rows){const {p}=example(f),notes=doseReference(p.profileId)!.notes;
  expect(patient.isPatientProjectionReviewed(p.profileId,DOSE_REFERENCE_VERSION,notes)).toBe(true);
  expect(patient.isPatientProjectionReviewed(p.profileId,DOSE_REFERENCE_VERSION,notes+' New patient warning')).toBe(false);
  expect(patient.isPatientProjectionReviewed(p.profileId,'future',notes)).toBe(false);
  expect(patient.isPatientProjectionReviewed('new-profile',DOSE_REFERENCE_VERSION,notes)).toBe(false);
 }
});
it('preserves authored warning and stop plan verbatim in both preview language fields',()=>{
 const {p}=example(fixtures.rows[0]);if(p.mode!=='calculated')throw Error();
 const plan='راجع الطبيب عند ظهور طفح. Stop and call the clinician as instructed.';
 p.input.reviewPlan=plan;const fields=patient.calculatedDoseFields(p)!;
 expect(fields.instructions).toContain(plan);expect(fields.instructionsEn).toContain(plan);
});
it('command and acknowledgement bind the new projection and authored plan',async()=>{
 const {canonicalPrescriptionCommand}=await import('../lib/prescription-command');
 const {canonicalPrescriptionForAck}=await import('../lib/prescription-safety-ack');
 const f=fixtures.rows[0],{row}=example(f),draft={...clone(f.draft),items:[row]} as PrescriptionDraft;
 const changed=clone(draft),p=changed.items[0].selection!.doseReview!;if(p.mode!=='calculated')throw Error();p.input.reviewPlan+=' revised';
 expect(canonicalPrescriptionCommand(draft)).not.toBe(canonicalPrescriptionCommand(changed));
 expect(canonicalPrescriptionForAck(draft)).not.toBe(canonicalPrescriptionForAck(changed));
});
