import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import { readAgreementAmendment, saveAgreementAmendment, readAgreementAmendmentAttemptStatus } from "@/lib/agreement-amendment-db";
export const dynamic="force-dynamic";
type C={params:Promise<{id:string}>};
const id=async(ctx:C)=>Number((await ctx.params).id);
const errorResponse=(e:unknown)=>{
 const bounded=bodyErrorResponse(e);if(bounded)return bounded;
 if(e instanceof DebtRepaymentError)return NextResponse.json({message:e.message,code:e.code},
  {status:e.code==="unauthorized"?403:e.code==="missing"?404:e.code==="invalid"?400:409});
 return NextResponse.json({message:"نتيجة التعديل غير مؤكدة؛ أعد نفس الطلب بالمفتاح المحفوظ أو افحص الحالة قبل أي طلب جديد."},{status:500});
};
export async function GET(_request:Request,ctx:C){
 const session=await requireSession();
 if(!session)return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401});
 try{return NextResponse.json(await readAgreementAmendment(await id(ctx),session));}catch(e){return errorResponse(e);}
}
export async function POST(request:Request,ctx:C){
 const session=await requireSession();
 if(!session)return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401});
 try{
  const data=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
  if(!data||typeof data!=="object"||Array.isArray(data))return NextResponse.json({message:"طلب غير صالح"},{status:400});
  const value=data as Record<string,unknown>;
  const result=await saveAgreementAmendment(await id(ctx),value as never,session);
  return NextResponse.json(result,{status:result.replayed?200:201});
 }catch(e){return errorResponse(e);}
}

/** Only an exact server-committed rejection record permits a fresh key. */
export async function PUT(request:Request,ctx:C){
 const session=await requireSession();
 if(!session)return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401});
 try{
  const value=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
  if(!value||typeof value!=="object"||Array.isArray(value))
    return NextResponse.json({message:"طلب غير صالح"},{status:400});
  const status=await readAgreementAmendmentAttemptStatus(await id(ctx),value as never,session);
  return NextResponse.json(status,{headers:{"Cache-Control":"no-store"}});
 }catch(e){return errorResponse(e);}
}
