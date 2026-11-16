import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { isCurrency } from "@/lib/money";
import { approveAgreement, type AgreementSource } from "@/lib/approved-agreements";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalPlanRefusal, commandCanonicalFinancialApproval } from "@/lib/canonical-plan-writes";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  // M2 slice 94d-1 (G4-1, G4-8): finance.invoices.create; a matched existing source also needs
  // finance.agreements.manage; the same body validation as legacy.
  const selected=await selectRequestStaffEnvelope();
  if(selected.kind==="denied")return NextResponse.json({message:"سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  const session=selected.kind==="canonical"?null:await requireSession();
  if(selected.kind!=="canonical"&&!session)return NextResponse.json({message:"سجّل الدخول من جديد."},{status:401});
  if(session&&!["admin","reception"].includes(session.role))return NextResponse.json({message:"الاعتماد المالي للإدارة والاستقبال."},{status:403});
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
    const planId=Number((await context.params).id);
    if(selected.kind==="canonical"){
      if(!Number.isSafeInteger(planId)||planId<=0)throw new DebtRepaymentError("invalid","رقم الخطة غير صالح.");
      const made=await commandCanonicalFinancialApproval(selected.handle,planId,{expectedTotalMinor:value.expectedTotalMinor,currency:value.currency,
        source:source as AgreementSource,reason:value.reason,idempotencyKey:request.headers.get("idempotency-key")??""});
      return NextResponse.json(made,{status:made.replayed?200:201,headers:NO_STORE});
    }
    const result=await approveAgreement({planId,expectedTotalMinor:value.expectedTotalMinor,currency:value.currency,
      source:source as AgreementSource,reason:value.reason,idempotencyKey:request.headers.get("idempotency-key")??"",session:session!});
    return NextResponse.json({planId:result.agreement.plan_id,replayed:result.replayed},{status:result.replayed?200:201});
  }catch(error){
    const bounded=bodyErrorResponse(error);if(bounded)return bounded;
    if(error instanceof CanonicalPlanRefusal)return NextResponse.json({message:error.message,code:error.code},{status:error.status,headers:NO_STORE});
    if(error instanceof DebtRepaymentError)return NextResponse.json({message:error.message,code:error.code},{status:error.code==="unauthorized"?403:selected.kind==="canonical"&&error.code==="missing"?404:error.code==="invalid"?400:409,
      ...(selected.kind==="canonical"?{headers:NO_STORE}:{})});
    if(selected.kind==="canonical")return canonicalPatientReadFailure(error,"تعذّر اعتماد الأصل. أعد الطلب نفسه؛ حدّث الخطة للتحقق قبل إنشاء طلب آخر.");
    return NextResponse.json({message:"تعذّر اعتماد الأصل. أعد الطلب نفسه؛ حدّث الخطة للتحقق قبل إنشاء طلب آخر."},{status:500});
  }
}
