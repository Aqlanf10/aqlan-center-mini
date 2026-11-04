import { RADIOLOGY_CENTER_UUID } from './radiology-centers';
/** Versioned clinician-authored request; never an imaging result or diagnosis engine. */
export const RADIOLOGY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type RadiologyRequestDraft = { patientId: number; visitId: number | null; centerId: string; examination: string; region: string; notes: string };
export type RadiologyRequestSnapshot = RadiologyRequestDraft & { version: 1; patientName: string; doctorId: number; doctorName: string; centerName: string; centerAddress: string; clinicName: string; clinicAddress: string; clinicPhone: string; timeZone: string };
export function parseRadiologyRequest(value: unknown): { key: string; draft: RadiologyRequestDraft } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('طلب غير صالح.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['commandKey','patientId','visitId','centerId','examination','region','notes'].includes(key))) throw new Error('حقول طلب غير معروفة.');
  const positive = (v: unknown): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > 2147483647) throw new Error('رقم الملف أو الزيارة غير صالح.'); return v; };
  const text = (v: unknown, max: number, required = true): string => {
    if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v) || (required && !v.trim())) throw new Error('تحقق من نصوص الطلب وحدودها.');
    return v.trim();
  };
  if (typeof row.commandKey !== 'string' || !RADIOLOGY_UUID.test(row.commandKey)) throw new Error('مفتاح الطلب غير صالح؛ حدّث الصفحة.');
  if (typeof row.centerId !== 'string' || !RADIOLOGY_CENTER_UUID.test(row.centerId)) throw new Error('اختر مركز أشعة صالحًا.');
  return { key: row.commandKey, draft: { patientId: positive(row.patientId), visitId: row.visitId == null ? null : positive(row.visitId), centerId: row.centerId,
    examination: text(row.examination, 200), region: text(row.region, 200), notes: text(row.notes ?? '', 2000, false) } };
}
export function canonicalRadiologyRequest(draft: RadiologyRequestDraft): unknown[] {
  return [1, draft.patientId, draft.visitId, draft.centerId, draft.examination, draft.region, draft.notes];
}

/** Decode persisted/restored data before any patient-scoped disclosure. */
export function decodeRadiologySnapshot(value: unknown, patientId:number, visitId:number|null, doctorId:number): RadiologyRequestSnapshot {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_RADIOLOGY_SNAPSHOT');
 const s=value as Record<string,unknown>;
 if(s.version!==1||s.patientId!==patientId||s.visitId!==visitId||s.doctorId!==doctorId)throw new Error('INVALID_RADIOLOGY_SNAPSHOT');
 const parsed=parseRadiologyRequest({commandKey:'00000000-0000-4000-8000-000000000000',patientId:s.patientId,visitId:s.visitId,centerId:s.centerId,examination:s.examination,region:s.region,notes:s.notes});
 const bounded=(key:string,max:number,required=true)=>{const v=s[key];if(typeof v!=='string'||v.length>max||(required&&!v.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v))throw new Error('INVALID_RADIOLOGY_SNAPSHOT');return v;};
 const timeZone=bounded('timeZone',100);try{new Intl.DateTimeFormat('en',{timeZone});}catch{throw new Error('INVALID_RADIOLOGY_SNAPSHOT');}
 return {...parsed.draft,version:1,doctorId,patientName:bounded('patientName',500),doctorName:bounded('doctorName',500),centerName:bounded('centerName',160),centerAddress:bounded('centerAddress',400),clinicName:bounded('clinicName',500),clinicAddress:bounded('clinicAddress',2000,false),clinicPhone:bounded('clinicPhone',200,false),timeZone};
}
