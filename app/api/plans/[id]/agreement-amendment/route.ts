import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import { readAgreementAmendment, saveAgreementAmendment, readAgreementAmendmentAttemptStatus } from "@/lib/agreement-amendment-db";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalPlanRefusal } from "@/lib/canonical-plan-writes";
import { CanonicalAgreementStale, commandCanonicalAgreementAmendment, readCanonicalAgreementAmendment, readCanonicalAgreementAmendmentStatus } from "@/lib/canonical-plan-agreements";
export const dynamic="force-dynamic";
type C={params:Promise<{id:string}>};
const id=async(ctx:C)=>Number((await ctx.params).id);
const ADMIN_ONLY="يتطلب تعديل اتفاق العلاج جلسة مدير سارية.";
const UNCERTAIN="نتيجة التعديل غير مؤكدة؛ أعد نفس الطلب بالمفتاح المحفوظ أو افحص الحالة قبل أي طلب جديد.";
const debtStatus=(code:DebtRepaymentError["code"])=>code==="unauthorized"?403:code==="missing"?404:code==="invalid"?400:409;
const errorResponse=(e:unknown)=>{
 const bounded=bodyErrorResponse(e);if(bounded)return bounded;
 if(e instanceof DebtRepaymentError)return NextResponse.json({message:e.message,code:e.code},{status:debtStatus(e.code)});
 return NextResponse.json({message:UNCERTAIN},{status:500});
};
/** M2 slice 94d-2 (G4-1, G4-8; contract section 13): finance.agreements.manage inside the
 * patient scope; an outside plan reads like a missing one; never cached. */
const canonicalError=(e:unknown)=>{
 const bounded=bodyErrorResponse(e);if(bounded)return bounded;
 if(e instanceof CanonicalAgreementStale||e instanceof DebtRepaymentError)return NextResponse.json({message:e.message,code:e.code},{status:e instanceof CanonicalAgreementStale?409:debtStatus(e.code),headers:NO_STORE});
 if(e instanceof CanonicalPlanRefusal)return NextResponse.json({message:e.message,code:e.code},{status:e.status,headers:NO_STORE});
 return canonicalPatientReadFailure(e,UNCERTAIN);
};
async function canonicalBody(request:Request){
 const data=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
 if(!data||typeof data!=="object"||Array.isArray(data))throw new DebtRepaymentError("invalid","طلب غير صالح");
 return data as never;
}
export async function GET(_request:Request,ctx:C){
 const selected=await selectRequestStaffEnvelope();
 if(selected.kind==="denied")return NextResponse.json({message:"يجب تسجيل الدخول"},{status:401,headers:NO_STORE});
 if(selected.kind==="canonical"){
  try{return NextResponse.json(await readCanonicalAgreementAmendment(selected.handle,await id(ctx)),{headers:NO_STORE});}catch(e){return canonicalError(e);}
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
   const result=await commandCanonicalAgreementAmendment(selected.handle,await id(ctx),await canonicalBody(request));
   return NextResponse.json(result,{status:result.replayed?200:201,headers:NO_STORE});
  }catch(e){return canonicalError(e);}
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
  try{return NextResponse.json(await readCanonicalAgreementAmendmentStatus(selected.handle,await id(ctx),await canonicalBody(request)),{headers:NO_STORE});}
  catch(e){return canonicalError(e);}
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
