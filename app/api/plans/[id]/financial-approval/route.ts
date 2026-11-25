import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { isCurrency } from "@/lib/money";
import { approveAgreement, type AgreementSource } from "@/lib/approved-agreements";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  const session=await requireSession();
  if(!session)return NextResponse.json({message:"سجّل الدخول من جديد."},{status:401});
  if(!["admin","reception"].includes(session.role))return NextResponse.json({message:"الاعتماد المالي للإدارة والاستقبال."},{status:403});
  try{
    const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
    if(!body||typeof body!=="object"||Array.isArray(body))throw new DebtRepaymentError("invalid","طلب غير صالح.");
    const value=body as Record<string,unknown>;
    if(Object.keys(value).some(key=>!["expectedTotalMinor","currency","source","reason"].includes(key))
      ||!isCurrency(value.currency)||typeof value.expectedTotalMinor!=="number"||typeof value.reason!=="string"
      ||!value.source||typeof value.source!=="object"||Array.isArray(value.source))throw new DebtRepaymentError("invalid","راجع مبلغ الاتفاق وعملته ومصدره.");
    const source=value.source as Record<string,unknown>;
    if(source.kind!=="new"&&source.kind!=="invoice"&&source.kind!=="opening"
      ||Object.keys(source).some(key=>!["kind",...(source.kind==="invoice"?["invoiceId"]:source.kind==="opening"?["historicalPaidMinor"]:[])].includes(key)))throw new DebtRepaymentError("invalid","مصدر غير صالح.");
    const result=await approveAgreement({planId:Number((await context.params).id),expectedTotalMinor:value.expectedTotalMinor,currency:value.currency,
      source:source as AgreementSource,reason:value.reason,idempotencyKey:request.headers.get("idempotency-key")??"",session});
    return NextResponse.json({planId:result.agreement.plan_id,replayed:result.replayed},{status:result.replayed?200:201});
  }catch(error){
    const bounded=bodyErrorResponse(error);if(bounded)return bounded;
    if(error instanceof DebtRepaymentError)return NextResponse.json({message:error.message,code:error.code},{status:error.code==="unauthorized"?403:error.code==="invalid"?400:409});
    return NextResponse.json({message:"تعذّر اعتماد الأصل. أعد الطلب نفسه؛ حدّث الخطة للتحقق قبل إنشاء طلب آخر."},{status:500});
  }
}
