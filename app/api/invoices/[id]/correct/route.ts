import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import { readInvoiceRevision, reviseInvoice } from "@/lib/invoice-revision-db";

export const dynamic = "force-dynamic";
type Context = {params:Promise<{id:string}>};
function failure(error:unknown){
  const bounded=bodyErrorResponse(error);if(bounded)return bounded;
  if(error instanceof DebtRepaymentError)return NextResponse.json({message:error.message,code:error.code},{status:error.code==="unauthorized"?403:error.code==="missing"?404:error.code==="invalid"?400:409});
  return NextResponse.json({message:"تعذّر تأكيد التصحيح. أعد الطلب نفسه للتحقق من النتيجة."},{status:500});
}
async function owner(context:Context){
  const session=await requireSession();if(!session||session.role!=="admin")throw new DebtRepaymentError("unauthorized","تصحيح الفاتورة يحتاج جلسة مدير سارية.");
  const id=Number((await context.params).id);if(!Number.isSafeInteger(id)||id<=0)throw new DebtRepaymentError("invalid","رقم الفاتورة غير صالح.");
  return {id,session};
}
export async function GET(_request:Request,context:Context){
  try{const {id,session}=await owner(context);return NextResponse.json(await readInvoiceRevision(id,session));}catch(error){return failure(error);}
}
export async function POST(request:Request,context:Context){
  try {
    const {id,session}=await owner(context);
    const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
    if(!body||typeof body!=="object"||Array.isArray(body))throw new DebtRepaymentError("invalid","طلب التصحيح غير صالح.");
    const result=await reviseInvoice(id,body as Record<string,unknown>,session);
    return NextResponse.json(result,{status:result.replayed?200:201});
  }catch(error){return failure(error);}
}
