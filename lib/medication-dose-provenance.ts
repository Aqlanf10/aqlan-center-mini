import { isDoseReferenceAcceptedForNewIssue } from './medication-dose-compatibility';
import { doseCalculationRule,doseReference,DOSE_REFERENCE_VERSION } from './medication-dose-profiles';
import { parseDoseReviewInput,parseDoseReviewInputV2,reviewMedicationDose,type AnyDoseReviewInput } from './medication-dose-review';

export interface CalculatedDoseResult { mgPerDose:number; mgPer24h:number; mlPerDose:number|null; tabletsPerDose:number|null }
export type MedicationDoseProvenance = { version:1|2; mode:'reference-only'; profileId:string; referenceVersion:string }
 | { version:1|2; mode:'calculated'; profileId:string; referenceVersion:string; input:AnyDoseReviewInput; result:CalculatedDoseResult };
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).sort().join('|')===[...keys].sort().join('|');
/** Shape-only parsing is also safe for saved history: never re-authorizes a saved
 * prescription against today's reference library. Issuance revalidation is below. */
export function parseMedicationDoseProvenance(value:unknown):MedicationDoseProvenance|null {
 if(!object(value)||(value.version!==1&&value.version!==2)||typeof value.profileId!=='string'||!value.profileId||value.profileId.length>100||typeof value.referenceVersion!=='string'||!value.referenceVersion||value.referenceVersion.length>100)return null;
 const common={version:value.version as 1|2,profileId:value.profileId,referenceVersion:value.referenceVersion};
 if(value.mode==='reference-only'&&exact(value,['version','mode','profileId','referenceVersion']))return {...common,mode:'reference-only'};
 if(value.mode!=='calculated'||!exact(value,['version','mode','profileId','referenceVersion','input','result']))return null;
 const input=(value.version===1?parseDoseReviewInput:parseDoseReviewInputV2)(value.input),r=value.result;
 if(!input||!object(r)||!exact(r,['mgPerDose','mgPer24h','mlPerDose','tabletsPerDose'])||['mgPerDose','mgPer24h'].some(k=>typeof r[k]!=='number'||!Number.isFinite(r[k]))||['mlPerDose','tabletsPerDose'].some(k=>r[k]!==null&&(typeof r[k]!=='number'||!Number.isFinite(r[k]))))return null;
 return {...common,mode:'calculated',input,result:{mgPerDose:r.mgPerDose as number,mgPer24h:r.mgPer24h as number,mlPerDose:r.mlPerDose as number|null,tabletsPerDose:r.tabletsPerDose as number|null}};
}
export function createCalculatedDoseProvenance(input:AnyDoseReviewInput):MedicationDoseProvenance|null {
 const version='minimumIntervalHours' in input.product?2:1;
 const parsed=(version===1?parseDoseReviewInput:parseDoseReviewInputV2)(input);if(!parsed)return null;
 const result=reviewMedicationDose(parsed);if(!result.ok)return null;
 return {version,mode:'calculated',profileId:input.profileId,referenceVersion:input.referenceVersion,input:parsed,result:{mgPerDose:result.mgPerDose,mgPer24h:result.mgPer24h,mlPerDose:result.mlPerDose,tabletsPerDose:result.tabletsPerDose}};
}
export function asManualDoseReference(value:MedicationDoseProvenance):MedicationDoseProvenance {
 return {version:value.version,mode:'reference-only',profileId:value.profileId,referenceVersion:value.referenceVersion};
}
/** Fields copied from the explicit preview; not a prescription until the actor
 * reviews the row and the existing issuer checks permissions and safety. */
export function calculatedDoseFields(provenance:MedicationDoseProvenance) {
 if(provenance.mode!=='calculated')return null;
 const input=provenance.input,r=provenance.result,reference=doseReference(provenance.profileId);
 if(!reference)return null;
 const rule=doseCalculationRule(provenance.profileId,input.ageMonths);
 const amount=r.mlPerDose===null?`${r.tabletsPerDose} tablet(s) (${r.mgPerDose} mg)`:`${r.mlPerDose} mL (${r.mgPerDose} mg)`;
 const frequency=input.scheduleKind==='prn-max'?`As needed; maximum ${input.administrationsPer24h} doses/24h; at least ${input.intervalHours} hours apart`:input.scheduleKind==='fixed-interval'?`Every ${input.intervalHours} hours (${input.administrationsPer24h} doses/24h)`:`${input.administrationsPer24h} times daily; at least ${input.intervalHours} hours apart`;
 return { name:reference.generic_name, dose:input.product.kind==='tablet'?`${input.product.strengthMg} mg/tablet`:`${input.product.strengthMg} mg/${input.product.perMl} mL`,form:input.product.kind==='tablet'?'Tablet':'Oral suspension',amount,frequency,duration:`${input.durationDays} days`,instructions:`${reference.notes} خطة المراجعة: ${input.reviewPlan}${rule?.instructionsAr?` ${rule.instructionsAr}`:''}`,instructionsEn:`Review plan: ${input.reviewPlan}${rule?.instructionsEn?` ${rule.instructionsEn}`:''}` };
}
export function medicationDoseProvenanceProblem(value:unknown,row:Record<string,unknown>):string|null {
 const p=parseMedicationDoseProvenance(value);
 if(!p||!isDoseReferenceAcceptedForNewIssue(p.profileId,p.referenceVersion))return 'مرجع الجرعة أو نسخته غير معروف؛ أعد الاختيار.';
 if(p.mode==='reference-only')return null;
 if(p.input.profileId!==p.profileId||p.input.referenceVersion!==p.referenceVersion)return 'مدخلات الحساب لا تطابق المرجع.';
 // Source-equivalent legacy input is verified against current semantics on a
 // temporary copy only. Original command, acknowledgement and snapshot bytes stay unchanged.
 const verificationInput=p.input.referenceVersion===DOSE_REFERENCE_VERSION?p.input:{...p.input,referenceVersion:DOSE_REFERENCE_VERSION};
 const recalculated=reviewMedicationDose(verificationInput);if(!recalculated.ok)return recalculated.problems.join(' ');
 if(['mgPerDose','mgPer24h','mlPerDose','tabletsPerDose'].some(key=>p.result[key as keyof CalculatedDoseResult]!==recalculated[key as keyof CalculatedDoseResult]))return 'نتيجة الحساب لا تطابق إعادة التحقق الخادمي.';
 const fields=calculatedDoseFields(p);if(!fields)return 'لا توجد حقول حساب صالحة.';
 const selection=object(row.selection)?row.selection:null;
 if(selection?.id!==doseCalculationRule(p.profileId,p.input.ageMonths)?.medicationId||selection?.amount!==fields.amount||Object.entries(fields).some(([key,val])=>key!=='amount'&&row[key]!==val))return 'تغيرت بيانات الدواء بعد الحساب؛ حوّلها إلى مراجعة يدوية وأكّدها من جديد.';
 return null;
}
export function canonicalMedicationDoseProvenance(value:MedicationDoseProvenance):string { return JSON.stringify(parseMedicationDoseProvenance(value)); }
