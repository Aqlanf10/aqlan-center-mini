/** Patient-facing projection v3. Historical v1/v2 implementation is immutable. */
import * as legacy from './medication-dose-provenance';
import { doseCalculationRule, doseReference, DOSE_REFERENCE_VERSION } from './medication-dose-profiles';
import type { AnyDoseReviewInput } from './medication-dose-review';
type LegacyCalculated = Extract<legacy.MedicationDoseProvenance,{mode:'calculated'}>;
export type MedicationDoseProvenance = legacy.MedicationDoseProvenance
 | {version:3;mode:'reference-only';profileId:string;referenceVersion:string}
 | (Omit<LegacyCalculated,'version'> & {version:3;inputVersion:1|2});
// Reviewed note classification, not a generic policy for future clinical sources.
const PATIENT_PROJECTION_REFERENCE_VERSION = '2026-11-03.topical-manual.1';
const REVIEWED_CLINICIAN_NOTES: Readonly<Record<string,string>> = Object.freeze({
  "paracetamol-adult-sdcep": "4000 سقف المصدر وليس جرعة افتراضية، وقد يلزم سقف أقل حسب المريض.",
  "paracetamol-child-aapd": "لا تُقسم جرعة mg/kg/dose على عدد المرات. عدد الجرعات والسقف المفرد يقرهما الطبيب/النشرة قبل التفعيل.",
  "ibuprofen-adult-sdcep": "بعد الطعام إن أمكن؛ لا ترفع مثال1600 إلى2400 تلقائيًا، والفاصل يحتاج نشرة المنتج.",
  "ibuprofen-child-sdcep": "لا تستبدل سقف30 بسقف40 من مرجع آخر. إذا تجاوزت جرعة الفئة سقف الوزن تُحال للمراجعة ولا تخفض صامتًا.",
  "amoxicillin-child-aapd-q8": "الكمية هنا يومية، تقسم3؛ لا تنقل الجرعة كما هي لكل مرة.",
  "amoxicillin-child-aapd-q12": "مسار مستقل عنq8؛ لا تبديل التكرار وحده."
});
export function isPatientProjectionReviewed(profileId:string,referenceVersion:string,notes:unknown):boolean {
 return referenceVersion===PATIENT_PROJECTION_REFERENCE_VERSION && referenceVersion===DOSE_REFERENCE_VERSION
  && Object.prototype.hasOwnProperty.call(REVIEWED_CLINICIAN_NOTES,profileId)
  && notes===REVIEWED_CLINICIAN_NOTES[profileId];
}
function reviewed(profileId:string,referenceVersion:string) {
 return isPatientProjectionReviewed(profileId,referenceVersion,doseReference(profileId)?.notes);
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).sort().join('|')===[...keys].sort().join('|');
export function parseMedicationDoseProvenance(value:unknown):MedicationDoseProvenance|null {
 if(!object(value)||value.version!==3)return legacy.parseMedicationDoseProvenance(value);
 if(value.mode==='reference-only'){
  if(!exact(value,['version','mode','profileId','referenceVersion']))return null;
  const parsed=legacy.parseMedicationDoseProvenance({...value,version:1});
  return parsed?.mode==='reference-only'?{...parsed,version:3}:null;
 }
 if(value.mode!=='calculated'||!exact(value,['version','inputVersion','mode','profileId','referenceVersion','input','result'])||(value.inputVersion!==1&&value.inputVersion!==2))return null;
 const {inputVersion,...rest}=value;
 const parsed=legacy.parseMedicationDoseProvenance({...rest,version:inputVersion});
 return parsed?.mode==='calculated'?{version:3,inputVersion,mode:parsed.mode,profileId:parsed.profileId,referenceVersion:parsed.referenceVersion,input:parsed.input,result:parsed.result}:null;
}
export function createCalculatedDoseProvenance(input:AnyDoseReviewInput):MedicationDoseProvenance|null {
 if(!reviewed(input.profileId,input.referenceVersion))return null;
 const p=legacy.createCalculatedDoseProvenance(input);
 return p?.mode==='calculated'?{version:3,inputVersion:p.version,mode:p.mode,profileId:p.profileId,referenceVersion:p.referenceVersion,input:p.input,result:p.result}:null;
}
export function asManualDoseReference(p:MedicationDoseProvenance):MedicationDoseProvenance {
 return {version:p.version,mode:'reference-only',profileId:p.profileId,referenceVersion:p.referenceVersion};
}
export function calculatedDoseFields(p:MedicationDoseProvenance) {
 if(p.version!==3)return legacy.calculatedDoseFields(p);
 if(p.mode!=='calculated'||!reviewed(p.profileId,p.referenceVersion))return null;
 // Preserve the authored plan verbatim and the reviewed patient-facing rule
 // advice. reference.notes stays visible to clinicians, never auto-copied here.
 const old=legacy.calculatedDoseFields({...p,version:p.inputVersion});
 if(!old)return null;
 const rule=doseCalculationRule(p.profileId,p.input.ageMonths);
 return {...old,instructions:`خطة المراجعة: ${p.input.reviewPlan}${rule?.instructionsAr?` ${rule.instructionsAr}`:''}`};
}
export function medicationDoseProvenanceProblem(value:unknown,row:Record<string,unknown>):string|null {
 if(!object(value)||value.version!==3)return legacy.medicationDoseProvenanceProblem(value,row);
 const p=parseMedicationDoseProvenance(value);
 if(!p||p.version!==3||!reviewed(p.profileId,p.referenceVersion))return 'نسخة عرض الجرعة للمريض غير صالحة؛ أعد الاختيار والمراجعة.';
 if(p.mode==='reference-only')return legacy.medicationDoseProvenanceProblem({...p,version:1},row);
 const old:LegacyCalculated={version:p.inputVersion,mode:p.mode,profileId:p.profileId,referenceVersion:p.referenceVersion,input:p.input,result:p.result};
 const fields=calculatedDoseFields(p),oldFields=legacy.calculatedDoseFields(old);
 if(!fields||!oldFields)return 'لا توجد حقول حساب صالحة.';
 if(Object.entries(fields).some(([key,val])=>key!=='amount'&&row[key]!==val))return 'تغيرت بيانات الدواء بعد الحساب؛ حوّلها إلى مراجعة يدوية وأكّدها من جديد.';
 // Verify the actual amount/ingredient and all old clinical/rule/label constraints
 // against a temporary projection only. No saved or canonical bytes are rewritten.
 return legacy.medicationDoseProvenanceProblem(old,{...row,...oldFields});
}
export function canonicalMedicationDoseProvenance(p:MedicationDoseProvenance):string {
 return JSON.stringify(parseMedicationDoseProvenance(p));
}
