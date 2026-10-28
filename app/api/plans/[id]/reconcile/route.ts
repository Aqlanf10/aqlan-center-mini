import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { AgreementReconciliationError, readAgreementReconciliation, saveAgreementReconciliation, readAgreementReconciliationAttemptStatus } from "@/lib/agreement-reconciliation-db";
import type { AgreementReconciliationCommand } from "@/lib/agreement-reconciliation";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function admission(context:Context) {
 const session=await requireSession();
 if(!session)return {response:NextResponse.json({code:"unauthorized",message:"انتهت الجلسة؛ سجّل الدخول للتحقق من نفس المحاولة."},{status:401})};
 if(session.role!=="admin")return {response:NextResponse.json({code:"unauthorized",message:"تسوية الاتفاق تحتاج صلاحية المدير."},{status:403})};
 const planId=Number((await context.params).id);
 if(!Number.isSafeInteger(planId)||planId<=0)return {response:NextResponse.json({code:"invalid",message:"رقم الخطة غير صالح."},{status:400})};
 return {session,planId};
}
function errorResponse(error:unknown) {
 const bounded=bodyErrorResponse(error);if(bounded)return bounded;
 if(error instanceof AgreementReconciliationError)return NextResponse.json({code:error.code,message:error.message},{status:error.status});
 return NextResponse.json({code:"agreement_reconciliation_unavailable",message:"تعذّر التحقق من التسوية. احتفظ بنفس الطلب وافحص حالته؛ لا تنشئ طلبًا جديدًا."},{status:503});
}
export async function GET(_request:Request,context:Context) {
 const admitted=await admission(context);if(admitted.response)return admitted.response;
 try{return NextResponse.json(await readAgreementReconciliation(admitted.planId!,admitted.session!));}catch(error){return errorResponse(error);}
}
export async function POST(request:Request,context:Context) {
 const admitted=await admission(context);if(admitted.response)return admitted.response;
 try{const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES) as AgreementReconciliationCommand;
 return NextResponse.json(await saveAgreementReconciliation(admitted.planId!,body,admitted.session!));}catch(error){return errorResponse(error);}
}
/** Status only: never writes a rejection or financial row; missing means unresolved. */
export async function PUT(request:Request,context:Context) {
 const admitted=await admission(context);if(admitted.response)return admitted.response;
 try{const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES) as AgreementReconciliationCommand;
 return NextResponse.json(await readAgreementReconciliationAttemptStatus(admitted.planId!,body,admitted.session!));}catch(error){return errorResponse(error);}
}
