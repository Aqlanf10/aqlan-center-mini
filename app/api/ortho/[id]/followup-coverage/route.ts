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
  try{const a=await admit(request,context);if(!a.ok)return a.response;
    return NextResponse.json(await readFollowupCoverage(a),{headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return e instanceof FollowupCoverageError?error(e.message,e.status,e.code,e.rejection):error("تعذّر التحقق من نطاق المتابعات؛ لم يُعتبر مشمولًا أو خارج الاتفاق.",500,"coverage_read_failed");}
}
export async function POST(request:Request,context:Context){
  try{const a=await admit(request,context);if(!a.ok)return a.response;
    let command:unknown;try{command=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);}catch(e){return bodyErrorResponse(e)??error("طلب غير صالح.",400);}
    const result=await appendFollowupCoverage({...a,command});
    return NextResponse.json(result,{status:result.replayed?200:201,headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return e instanceof FollowupCoverageError?error(e.message,e.status,e.code,e.rejection):error("تعذّر تأكيد حفظ القرار؛ راجع السجل قبل إنشاء طلب جديد.",500,"coverage_result_unknown");}
}

export async function PUT(request:Request,context:Context){
  try{const a=await admit(request,context);if(!a.ok)return a.response;
    let command:unknown;try{command=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);}catch(e){return bodyErrorResponse(e)??error("طلب غير صالح.",400);}
    return NextResponse.json(await readFollowupCoverageCommandStatus({...a,command}),{headers:{"Cache-Control":"private, no-store"}});
  }catch(e){return e instanceof FollowupCoverageError?error(e.message,e.status,e.code,e.rejection):error("تعذّر التحقق من نتيجة الطلب؛ يبقى معلّقًا.",500,"coverage_result_unknown");}
}
