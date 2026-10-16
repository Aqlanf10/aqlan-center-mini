import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { isCurrency } from "@/lib/money";
import { DebtRepaymentError, debtRepaymentWorkspace, saveDebtRepayment } from "@/lib/debt-installments-db";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
const denial=(status:number)=>NextResponse.json({message:status===401?"سجّل الدخول من جديد.":"إدارة ترتيب السداد للإدارة والاستقبال."},{status});
export async function GET(_request:Request,context:Context){
  const session=await requireSession();if(!session)return denial(401);if(!["admin","reception"].includes(session.role))return denial(403);
  const patientId=Number((await context.params).id);if(!Number.isSafeInteger(patientId)||patientId<=0)return NextResponse.json({message:"رقم المريض غير صالح."},{status:400});
  try{return NextResponse.json(await debtRepaymentWorkspace(patientId,clinicDateString(new Date(),CLINIC_TIME_ZONE)),{headers:{"Cache-Control":"no-store"}});}
  catch{return NextResponse.json({message:"تعذّر قراءة ترتيب السداد؛ حدّث الحساب."},{status:500});}
}
export async function POST(request:Request,context:Context){
  const session=await requireSession();if(!session)return denial(401);if(!["admin","reception"].includes(session.role))return denial(403);
  const patientId=Number((await context.params).id);
  try{
    const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
    if(!body||typeof body!=="object"||Array.isArray(body))throw new DebtRepaymentError("invalid","طلب غير صالح.");
    const source=body as Record<string,unknown>;
    if(Object.keys(source).some(key=>!["invoiceId","openingCurrency","currency","terms","expectedVersion","expectedRemainingMinor","expectedSourceHash","reason","idempotencyKey","cancel"].includes(key))
      ||!isCurrency(source.currency)||typeof source.expectedVersion!=="number"||typeof source.expectedRemainingMinor!=="number"
      ||typeof source.expectedSourceHash!=="string"||!/^[a-f0-9]{64}$/.test(source.expectedSourceHash)
      ||typeof source.reason!=="string"||typeof source.idempotencyKey!=="string"||source.cancel!==undefined&&typeof source.cancel!=="boolean"
      ||source.invoiceId!==null&&!(typeof source.invoiceId==="number"&&Number.isSafeInteger(source.invoiceId)&&source.invoiceId>0)
      ||source.openingCurrency!==null&&!isCurrency(source.openingCurrency))throw new DebtRepaymentError("invalid","راجع بيانات ترتيب السداد والنسخة الحالية.");
    const result=await saveDebtRepayment({target:{patientId,currency:source.currency,invoiceId:source.invoiceId as number|null,openingCurrency:source.openingCurrency},
      terms:source.terms,expectedVersion:source.expectedVersion,expectedRemainingMinor:source.expectedRemainingMinor,expectedSourceHash:source.expectedSourceHash,
      reason:source.reason,idempotencyKey:source.idempotencyKey,cancel:source.cancel as boolean|undefined,session});
    return NextResponse.json(result,{status:result.replayed?200:201});
  }catch(error){
    const bounded=bodyErrorResponse(error);if(bounded)return bounded;
    if(error instanceof DebtRepaymentError)return NextResponse.json({code:error.code,message:error.message},{status:error.code==="unauthorized"?401:error.code==="invalid"?400:409});
    return NextResponse.json({message:"تعذّر حفظ الترتيب؛ أعد الطلب نفسه بالمفتاح نفسه."},{status:500});
  }
}
