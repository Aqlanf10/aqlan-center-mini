import { NextResponse } from 'next/server';
import type { SessionPayload } from './auth';
import { RadiologyRequestError } from './radiology-request-service';
export const radiologyJson = (value: unknown, status=200) => NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
export function radiologyFailure(error: unknown) {
 if(error && typeof error==='object' && 'code' in error && ['42P01','42703'].includes(String(error.code))) return radiologyJson({message:'خدمة طلبات الأشعة غير جاهزة؛ لم يتم إنشاء طلب جديد.'},503);
 if(error instanceof RadiologyRequestError) return radiologyJson({message:error.message},error.status);
 if(error && typeof error==='object' && 'code' in error && ['55P03','40P01','40001'].includes(String(error.code))) return radiologyJson({message:'تغيّرت البيانات أثناء العملية؛ أعد المحاولة بنفس الطلب.'},409);
 return radiologyJson({message:'تعذرت العملية؛ تحقق من سجل الطلب قبل إعادة المحاولة.'},500);
}
export function radiologyId(raw: string | null): number { const n=Number(raw); if(!raw || !Number.isSafeInteger(n)||n<=0||n>2147483647) throw new Error('رقم غير صالح.'); return n; }

/** Denial-only transport fence. A signed role never grants clinical access;
 * the service still revalidates current credentials, role, grants and scope. */
export function radiologyRoleDenial(session: SessionPayload, clinical: boolean) {
 const roles = clinical ? ['admin', 'doctor'] : ['admin', 'doctor', 'reception'];
 return roles.includes(session.role) ? null : radiologyJson({message:'لا تملك صلاحية هذه العملية.'},403);
}
