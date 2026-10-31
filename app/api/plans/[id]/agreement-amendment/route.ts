import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalPlanCaseFailure } from "@/lib/canonical-plans-and-cases";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import {
  readAgreementAmendment,
  readCanonicalAgreementAmendment,
  saveAgreementAmendment,
  saveCanonicalAgreementAmendment,
  readAgreementAmendmentAttemptStatus,
  readCanonicalAgreementAmendmentAttemptStatus,
} from "@/lib/agreement-amendment-db";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
export const dynamic="force-dynamic";
type C={params:Promise<{id:string}>};
const id=async(ctx:C)=>Number((await ctx.params).id);
const ADMIN_ONLY="يتطلب تعديل اتفاق العلاج جلسة مدير سارية.";
const errorResponse=(e:unknown)=>{
 const bounded=bodyErrorResponse(e);if(bounded)return bounded;
 if(e instanceof DebtRepaymentError)return NextResponse.json({message:e.message,code:e.code},
  {status:e.code==="unauthorized"?403:e.code==="missing"?404:e.code==="invalid"?400:409});
 return NextResponse.json({message:"نتيجة التعديل غير مؤكدة؛ أعد نفس الطلب بالمفتاح المحفوظ أو افحص الحالة قبل أي طلب جديد."},{status:500});
};
const canonicalErrorResponse=(e:unknown)=>{
 const bounded=bodyErrorResponse(e);if(bounded)return bounded;
 if(e instanceof DebtRepaymentError)return NextResponse.json({message:e.message,code:e.code},
  {status:e.code==="unauthorized"?403:e.code==="missing"?404:e.code==="invalid"?400:409,headers:NO_STORE});
 return canonicalPlanCaseFailure(e,"نتيجة التعديل غير مؤكدة؛ أعد نفس الطلب بالمفتاح المحفوظ أو افحص الحالة قبل أي طلب جديد.");
};
export async function GET(_request:Request,ctx:C){
 const selected=await selectRequestStaffEnvelope();
 if(selected.kind==="denied")return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401,headers:NO_STORE});
 if(selected.kind==="canonical"){
  try{return NextResponse.json(await readCanonicalAgreementAmendment(await id(ctx),selected.handle),{headers:NO_STORE});}
  catch(e){return canonicalErrorResponse(e);}
 }
 const session=await requireSession();
 if(!session)return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401});
 try{return NextResponse.json(await readAgreementAmendment(await id(ctx),session));}catch(e){return errorResponse(e);}
}
export async function POST(request:Request,ctx:C){
 const selected=await selectRequestStaffEnvelope();
 if(selected.kind==="denied")return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401,headers:NO_STORE});
 if(selected.kind==="canonical"){
  try{
   const data=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
   if(!data||typeof data!=="object"||Array.isArray(data))return NextResponse.json({message:"طلب غير صالح"},{status:400,headers:NO_STORE});
   const result=await saveCanonicalAgreementAmendment(await id(ctx),data as never,selected.handle);
   return NextResponse.json(result,{status:result.replayed?200:201,headers:NO_STORE});
  }catch(e){return canonicalErrorResponse(e);}
 }
 const session=await requireSession();
 if(!session)return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401});
 // Authority before body shape: a non-admin is refused with 403 whatever it sends.
 if(session.role!=="admin")return NextResponse.json({message:ADMIN_ONLY,code:"unauthorized"},{status:403});
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
 const selected=await selectRequestStaffEnvelope();
 if(selected.kind==="denied")return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401,headers:NO_STORE});
 if(selected.kind==="canonical"){
  try{
   const value=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
   if(!value||typeof value!=="object"||Array.isArray(value))
     return NextResponse.json({message:"طلب غير صالح"},{status:400,headers:NO_STORE});
   const status=await readCanonicalAgreementAmendmentAttemptStatus(await id(ctx),value as never,selected.handle);
   return NextResponse.json(status,{headers:NO_STORE});
  }catch(e){return canonicalErrorResponse(e);}
 }
 const session=await requireSession();
 if(!session)return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401});
 if(session.role!=="admin")return NextResponse.json({message:ADMIN_ONLY,code:"unauthorized"},{status:403});
 try{
  const value=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
  if(!value||typeof value!=="object"||Array.isArray(value))
    return NextResponse.json({message:"طلب غير صالح"},{status:400});
  const status=await readAgreementAmendmentAttemptStatus(await id(ctx),value as never,session);
  return NextResponse.json(status,{headers:{"Cache-Control":"no-store"}});
 }catch(e){return errorResponse(e);}
}
