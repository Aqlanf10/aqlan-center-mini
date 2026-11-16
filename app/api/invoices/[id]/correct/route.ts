import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import { readInvoiceRevision, reviseInvoice } from "@/lib/invoice-revision-db";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { commandCanonicalInvoiceRevision, readCanonicalInvoiceRevision } from "@/lib/canonical-invoice-corrections";

export const dynamic = "force-dynamic";
type Context = {params:Promise<{id:string}>};
function failure(error:unknown){
  const bounded=bodyErrorResponse(error);if(bounded)return bounded;
  if(error instanceof DebtRepaymentError)return NextResponse.json({message:error.message,code:error.code},{status:error.code==="unauthorized"?403:error.code==="missing"?404:error.code==="invalid"?400:409});
  return NextResponse.json({message:"تعذّر تأكيد التصحيح. أعد الطلب نفسه للتحقق من النتيجة."},{status:500});
}
/** M2 slice 93c (G4-8): finance.invoices.correct inside the patient scope on the canonical runtime. */
async function canonical<T>(run:(handle:Parameters<typeof readCanonicalInvoiceRevision>[0])=>Promise<T>,status?:(value:T)=>number){
  const selected=await selectRequestStaffEnvelope();
  if(selected.kind==="denied")return NextResponse.json({message:"انتهت الجلسة. سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  if(selected.kind!=="canonical")return null;
  try{const value=await run(selected.handle);return NextResponse.json(value,{status:status?status(value):200,headers:NO_STORE});}
  catch(error){
    if(error instanceof DebtRepaymentError||bodyErrorResponse(error)){const response=failure(error);response.headers.set("Cache-Control","private, no-store");return response;}
    return canonicalPatientReadFailure(error,"تعذّر تأكيد التصحيح. أعد الطلب نفسه للتحقق من النتيجة.");
  }
}
async function owner(context:Context){
  const session=await requireSession();if(!session||session.role!=="admin")throw new DebtRepaymentError("unauthorized","تصحيح الفاتورة يحتاج جلسة مدير سارية.");
  const id=Number((await context.params).id);if(!Number.isSafeInteger(id)||id<=0)throw new DebtRepaymentError("invalid","رقم الفاتورة غير صالح.");
  return {id,session};
}
export async function GET(_request:Request,context:Context){
  const routed=await canonical(async handle=>readCanonicalInvoiceRevision(handle,(await context.params).id));if(routed)return routed;
  try{const {id,session}=await owner(context);return NextResponse.json(await readInvoiceRevision(id,session));}catch(error){return failure(error);}
}
export async function POST(request:Request,context:Context){
  const routed=await canonical(async handle=>commandCanonicalInvoiceRevision(handle,(await context.params).id,await readJsonBody(request,JSON_BODY_LIMIT_BYTES)),value=>value.replayed?200:201);
  if(routed)return routed;
  try {
    const {id,session}=await owner(context);
    const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
    if(!body||typeof body!=="object"||Array.isArray(body))throw new DebtRepaymentError("invalid","طلب التصحيح غير صالح.");
    const result=await reviseInvoice(id,body as Record<string,unknown>,session);
    return NextResponse.json(result,{status:result.replayed?200:201});
  }catch(error){return failure(error);}
}
