import { settingDefinition } from "../lib/settings-definitions";
import { describe, expect, it } from 'vitest';
import { parseMedicationCatalog, catalogTransitionProblem, catalogMedicationToDraft, catalogSelectionProblem, type CatalogMedication } from '../lib/medication-catalog';
import { validateTypedSetting } from '../lib/settings-validate';
import { sanitizeRxItem } from '../lib/prescription';
import { canonicalPrescriptionForAck } from '../lib/prescription-safety-ack';
import { canonicalPrescriptionCommand } from '../lib/prescription-command';
const entry:CatalogMedication={id:'11111111-1111-4111-8111-111111111111',revision:1,enabled:true,name:'Synthetic medicine',arabicName:'اختبار',form:'tablet',strength:'1 mg',population:'adult',amount:'',frequency:'',duration:'',instructionsAr:'',instructionsEn:'',indication:'Synthetic only',cautions:'Not clinical advice',sourceUrl:'https://example.org/label'};
const doc=(entries:CatalogMedication[])=>({schemaVersion:1 as const,entries});
describe('bounded medication catalogue',()=>{
 it('accepts normalized exact records through generic settings validator',()=>{expect(parseMedicationCatalog(JSON.stringify(doc([entry]))).ok).toBe(true);expect(validateTypedSetting('clinical.medication_catalog',JSON.stringify(doc([entry])))).toBeNull();});
 it.each([{...entry,approved:true},{...entry,id:'bad'},{...entry,revision:0},{...entry,sourceUrl:'javascript:alert(1)'},{...entry,name:' bad '},{...entry,strength:''},{...entry,name:'a'.repeat(201)}])('rejects malformed or approval fields',e=>expect(parseMedicationCatalog(JSON.stringify({schemaVersion:1,entries:[e]})).ok).toBe(false));
 it('rejects duplicate IDs, unknown top fields and oversized collections',()=>{for(const d of [doc([entry,entry]),{...doc([]),approved:true},doc(Array(61).fill(entry))])expect(parseMedicationCatalog(JSON.stringify(d)).ok).toBe(false);});
 it('requires monotonic revisions and disable rather than deletion',()=>{expect(catalogTransitionProblem(doc([entry]),doc([]))).not.toBeNull();expect(catalogTransitionProblem(doc([entry]),doc([{...entry,enabled:false}]))).not.toBeNull();expect(catalogTransitionProblem(doc([entry]),doc([{...entry,enabled:false,revision:2}]))).toBeNull();expect(catalogTransitionProblem(doc([]),doc([{...entry,revision:2}]))).not.toBeNull();});
 it('copies immutable values to an unconfirmed draft, preserves provenance through sanitizing',()=>{const item=catalogMedicationToDraft(entry)!;expect(item.selection).toEqual({id:'manual',amount:'',confirmed:false,catalog:{id:entry.id,revision:1}});expect(sanitizeRxItem(item)?.selection?.catalog).toEqual(item.selection?.catalog);expect(catalogMedicationToDraft({...entry,enabled:false})).toBeNull();expect(catalogSelectionProblem([item],doc([{...entry,revision:2}]))).not.toBeNull();expect(item.dose).toBe('1 mg');expect(catalogSelectionProblem([item],doc([entry]))).toBeNull();});
 it('binds command fingerprint to catalogue revision without changing noncatalogue semantics',()=>{const item=catalogMedicationToDraft(entry)!;const draft={patientId:1,visitId:null,diagnosis:'test',notes:'',instructionsLang:'both' as const,items:[item]};const first=canonicalPrescriptionCommand(draft);item.selection!.catalog!.revision=2;expect(canonicalPrescriptionCommand(draft)).not.toBe(first);});
});
it('retains the pre-catalogue version1 command bytes exactly',()=>{
 const draft={patientId:1,visitId:null,diagnosis:'',notes:'',instructionsLang:'both' as const,items:[{name:'Synthetic',dose:'1 mg',form:'tablet',frequency:'manual',duration:'manual',instructions:'',instructionsEn:'',selection:{id:'manual' as const,amount:'1 tablet',confirmed:true}}]};
 expect(canonicalPrescriptionCommand(draft)).toBe('{"version":1,"patientId":1,"visitId":null,"prescribingDoctorPartyId":null,"diagnosis":"","notes":"","instructionsLang":"both","items":[["Synthetic","1 mg","tablet","manual","manual","","","manual","1 tablet",true]]}');
});

it('binds safety acknowledgement to catalogue revision but keeps plain acknowledgement shape stable',()=>{
 const item=catalogMedicationToDraft(entry)!;
 const draft={patientId:1,visitId:null,diagnosis:'',notes:'',instructionsLang:'both' as const,items:[item]};
 const original=canonicalPrescriptionForAck(draft);item.selection!.catalog!.revision=2;expect(canonicalPrescriptionForAck(draft)).not.toBe(original);
 delete item.selection!.catalog;
 expect(canonicalPrescriptionForAck(draft)).toBe(JSON.stringify({ownerAuthority:null,prescribingDoctorName:'',prescribingDoctorPartyId:null,patientId:1,visitId:null,diagnosis:'',notes:'',instructionsLang:'both',items:[[item.name,item.dose,item.form,item.frequency,item.duration,item.instructions,item.instructionsEn,'manual','',false]]}));
});

it('declares catalogue as normal audited clinic metadata, never a secret or authority grant',()=>{
 expect(settingDefinition('clinical.medication_catalog')).toMatchObject({category:'clinical',scope:'clinic',type:'JSON',sensitivity:'normal',requiresReason:true,permission:'settings.manage'});
});
