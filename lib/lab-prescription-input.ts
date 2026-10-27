import { ADULT_FDI_TEETH, PRIMARY_FDI_TEETH, LAB_TOOTH_ROLE_META, LAB_IMPRESSION_LABEL, LAB_PRIORITY_LABEL, VITA_CLASSICAL_SHADES, VITA_BLEACH_SHADES, VITA_3D_MASTER_SHADES, STUMP_SHADES_ND, type LabOrderClinicalDTO, type LabOrder, type LabImpressionType, type LabOrderPriority } from "./lab";
export const LAB_PRESCRIPTION_SHADES = [...VITA_CLASSICAL_SHADES, ...VITA_BLEACH_SHADES, ...VITA_3D_MASTER_SHADES];
export type LabPrescriptionInput = { partyId:number|null; shade:string; stumpShade:string; toothNumbers:string; dueDate:string; impressionType:LabImpressionType; priority:LabOrderPriority };
export function labPrescriptionVersion(order: Pick<LabOrderClinicalDTO,"status"|"partyId"|"shade"|"stumpShade"|"toothNumbers"|"dueDate"|"impressionType"|"priority"|"workType"|"source"|"toothCode"|"visitId">): string {
 return JSON.stringify([order.status,order.partyId??null,order.shade??"",order.stumpShade??"",order.toothNumbers??"",order.dueDate,order.impressionType,order.priority,order.workType,order.source??null,order.toothCode??null,order.visitId??null]);
}
export function hasPostedLabPayable(order: Pick<LabOrder,"isPosted"|"payableId">): boolean { return !!order.isPosted && !!order.payableId; }
export function validateLabPrescription(value: unknown, requireComplete = true): LabPrescriptionInput {
 const fail = (): never => {throw new Error("راجع المختبر واللون وأدوار الأسنان وتاريخ التسليم؛ يجب استكمالها قبل تسجيل الإرسال.");};
 if (!value || typeof value!=="object" || Array.isArray(value)) return fail();
 const v=value as Record<string,unknown>;
 const keys=["partyId","shade","stumpShade","toothNumbers","dueDate","impressionType","priority"];
 if(Object.keys(v).some(k=>!keys.includes(k)) || (v.partyId !== null && (!Number.isSafeInteger(v.partyId) || Number(v.partyId)<=0)) || (requireComplete && v.partyId === null)) return fail();
 if(keys.slice(1).some(k=>typeof v[k]!=="string")) return fail();
 const p=v as unknown as LabPrescriptionInput;
 if((p.shade ? !LAB_PRESCRIPTION_SHADES.includes(p.shade) : requireComplete) || (p.stumpShade && ![...LAB_PRESCRIPTION_SHADES,...STUMP_SHADES_ND].includes(p.stumpShade))) return fail();
 if(!Object.hasOwn(LAB_IMPRESSION_LABEL,p.impressionType) || !Object.hasOwn(LAB_PRIORITY_LABEL,p.priority)) return fail();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate) || !Number.isFinite(Date.parse(p.dueDate)) || new Date(p.dueDate).toISOString().slice(0,10)!==p.dueDate) return fail();
 const validCodes:number[]=[...Object.values(ADULT_FDI_TEETH).flat(),...Object.values(PRIMARY_FDI_TEETH).flat()];
 const seen=new Set<number>();
 const parts=p.toothNumbers ? p.toothNumbers.split(",") : [];
 if((requireComplete && !p.toothNumbers) || p.toothNumbers.length>2000) return fail();
 for(const part of parts){
  const match=part.trim().match(/^(\d{2})\(([^)]+)\)$/);
  const code=Number(match?.[1]);
  if(!match || !validCodes.includes(code) || seen.has(code) || !Object.values(LAB_TOOTH_ROLE_META).some(m=>m.englishLabel===match[2])) return fail();
  seen.add(code);
 }
 return {...p,toothNumbers:parts.map(p=>p.trim()).join(", ")};
}

/** Source invariants only, not a substitute for clinical review. Never infer new geometry. */
export function assertAutoLabSource(input: LabPrescriptionInput, source: { source: string | null; tooth_code: number | null; work_type: string }) {
 if (source.source !== "auto" || !input.toothNumbers) return;
 const teeth = input.toothNumbers.split(",").map(part => ({code:Number(part.trim().slice(0,2)),role:part.trim().match(/\(([^)]+)\)/)?.[1]}));
 if (source.tooth_code !== null && !teeth.some(tooth => tooth.code === source.tooth_code)) throw new Error("يجب إبقاء سن الإجراء الأصلي ضمن الإرسالية. تصحيح السن الموقّع يحتاج مسار تصحيح مستقل.");
 if (source.tooth_code !== null && source.work_type !== "جسر" && teeth.length !== 1) throw new Error("هذا الطلب من إجراء سن منفرد؛ لا تُضف أسنانًا من أعمال مستقلة إلى نفس الإرسالية.");
 const roles:Record<string,string[]>={"تاج":["Crown","Implant Crown"],"جسر":["Abutment","Pontic"],"قشرة (فينير)":["Veneer"]};
 const allowed=roles[source.work_type];
 if (allowed && teeth.some(tooth => !allowed.includes(tooth.role ?? ""))) throw new Error("دور السن لا يطابق نوع العمل الأصلي؛ راجع المواصفات دون تغيير الإجراء الموقّع.");
}

/** Explicit source geometry is immutable after materialization, independently of unknown draft roles. */
export function assertExplicitLabSource(input:LabPrescriptionInput,sourceCodes:readonly number[],workType:string):string {
 const expected=[...new Set(sourceCodes)].sort((a,b)=>a-b);
 if(!expected.length)throw new Error("تعذّر التحقق من نطاق مصدر الإرسالية.");
 if(!input.toothNumbers)return expected.join(", "); // neutral teeth, never invented roles
 const actual=input.toothNumbers.split(",").map(part=>Number(part.trim().slice(0,2))).sort((a,b)=>a-b);
 if(actual.length!==expected.length||actual.some((code,index)=>code!==expected[index]))throw new Error("أسنان الإرسالية مرتبطة بهوية العمل الأصلية؛ تغيير النطاق يحتاج تصحيحًا سريريًا مستقلًا.");
 assertAutoLabSource(input,{source:"auto",tooth_code:null,work_type:workType});
 return input.toothNumbers;
}
