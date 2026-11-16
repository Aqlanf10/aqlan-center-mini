import { canonicalCoverageReadQuery, readCanonicalCoverageEditor } from "@/lib/canonical-ortho-coverage-editor";
import { commandCanonicalFollowupCoverage } from "@/lib/canonical-ortho-coverage-command";
import { readCanonicalCoverageCommandStatus } from "@/lib/canonical-ortho-coverage-status";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { canonicalCoverageQuery, readCanonicalOrthoCoverage } from "@/lib/canonical-ortho-coverage";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { appendFollowupCoverage, readFollowupCoverage, readFollowupCoverageCommandStatus, FollowupCoverageError } from "@/lib/ortho-followup-coverage-db";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
const error=(message:string,status:number,code?:string,rejection?:FollowupCoverageError["rejection"])=>NextResponse.json({message,...(code?{code}:{}),...(rejection?{rejection}:{})},{status,headers:{"Cache-Control":"private, no-store"}});
async function admit(request:Request,context:Context){
  const session=await requireSession();
  if(!session)return {ok:false as const,response:error("انتهت الجلسة. سجّل الدخول من جديد.",401)};
  if(session.role!=="admin")return {ok:false as const,response:error("اعتماد نطاق المتابعات للإدارة فقط.",403)};
  const orthoCaseId=Number((await context.params).id),patientId=Number(new URL(request.url).searchParams.get("patientId"));
  if(![orthoCaseId,patientId].every(id=>Number.isSafeInteger(id)&&id>0))return {ok:false as const,response:error("معرف الحالة أو المريض غير صالح.",400)};
  return {ok:true as const,session,patientId,orthoCaseId};
}
export async function GET(request:Request,context:Context){
  const selected=await selectRequestStaffEnvelope();
  if(selected.kind==="denied")return NextResponse.json({message:"انتهت الجلسة. سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  if(selected.kind==="canonical"){
    try{
      const {caseId,patientId,edit}=canonicalCoverageReadQuery((await context.params).id,new URL(request.url).searchParams);
      return NextResponse.json(await (edit?readCanonicalCoverageEditor(selected.handle,patientId,caseId):readCanonicalOrthoCoverage(selected.handle,patientId,caseId)),{headers:NO_STORE});
    }catch(e){return canonicalPatientReadFailure(e,"تعذّر التحقق من نطاق المتابعات؛ لم يُعتبر مشمولًا أو خارج الاتفاق.");}
  }
  try{const a=await admit(request,context);if(!a.ok)return a.response;
    return NextResponse.json(await readFollowupCoverage(a),{headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return e instanceof FollowupCoverageError?error(e.message,e.status,e.code,e.rejection):error("تعذّر التحقق من نطاق المتابعات؛ لم يُعتبر مشمولًا أو خارج الاتفاق.",500,"coverage_read_failed");}
}
export async function POST(request:Request,context:Context){
  const selected=await selectRequestStaffEnvelope();
  if(selected.kind==="denied")return NextResponse.json({message:"انتهت الجلسة. سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  if(selected.kind==="canonical"){
    try{
      const {caseId,patientId}=canonicalCoverageQuery((await context.params).id,new URL(request.url).searchParams);
      const command=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
      const result=await commandCanonicalFollowupCoverage(selected.handle,patientId,caseId,command);
      return NextResponse.json(result,{status:result.replayed?200:201,headers:NO_STORE});
    }catch(e){
      const bounded=bodyErrorResponse(e);if(bounded)return bounded;
      if(e instanceof FollowupCoverageError)return error(e.message,e.status,e.code,e.rejection);
      return canonicalPatientReadFailure(e,"تعذّر تأكيد حفظ القرار؛ تحقق من نتيجة الطلب نفسه قبل المتابعة.");
    }
  }
  try{const a=await admit(request,context);if(!a.ok)return a.response;
    let command:unknown;try{command=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);}catch(e){return bodyErrorResponse(e)??error("طلب غير صالح.",400);}
    const result=await appendFollowupCoverage({...a,command});
    return NextResponse.json(result,{status:result.replayed?200:201,headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return e instanceof FollowupCoverageError?error(e.message,e.status,e.code,e.rejection):error("تعذّر تأكيد حفظ القرار؛ راجع السجل قبل إنشاء طلب جديد.",500,"coverage_result_unknown");}
}

export async function PUT(request:Request,context:Context){
  const selected=await selectRequestStaffEnvelope();
  if(selected.kind==="denied")return NextResponse.json({message:"انتهت الجلسة. سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  if(selected.kind==="canonical"){
    try{
      const {caseId,patientId}=canonicalCoverageQuery((await context.params).id,new URL(request.url).searchParams);
      const command=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);
      return NextResponse.json(await readCanonicalCoverageCommandStatus(selected.handle,patientId,caseId,command),{headers:NO_STORE});
    }catch(e){
      const bounded=bodyErrorResponse(e);if(bounded)return bounded;
      if(e instanceof FollowupCoverageError)return error(e.message,e.status,e.code);
      return canonicalPatientReadFailure(e,"تعذّر التحقق من نتيجة الطلب؛ يبقى معلّقًا.");
    }
  }
  try{const a=await admit(request,context);if(!a.ok)return a.response;
    let command:unknown;try{command=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);}catch(e){return bodyErrorResponse(e)??error("طلب غير صالح.",400);}
    return NextResponse.json(await readFollowupCoverageCommandStatus({...a,command}),{headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return e instanceof FollowupCoverageError?error(e.message,e.status,e.code,e.rejection):error("تعذّر التحقق من نتيجة الطلب؛ يبقى معلّقًا.",500,"coverage_result_unknown");}
}
