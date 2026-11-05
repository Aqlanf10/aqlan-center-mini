import { readJsonBody, bodyErrorResponse } from '@/lib/http-body';
import { readSessionPayload } from '@/lib/session';
import { parseRadiologyRequest } from '@/lib/radiology-request';
import { issueRadiologyRequest } from '@/lib/radiology-request-service';
import { radiologyJson, radiologyFailure, radiologyRoleDenial } from '@/lib/radiology-http';
export async function POST(request: Request) {
 const session=await readSessionPayload(); if(!session?.credentialVersion) return radiologyJson({message:'سجّل الدخول من جديد.'},401);
 const denied=radiologyRoleDenial(session,true);if(denied)return denied;
 let parsed; try {
  const body=await readJsonBody(request,16000);
  if(!body||typeof body!=='object'||Array.isArray(body))return radiologyJson({message:'حقول طلب الأشعة غير صالحة.'},400);
  const {__expectedActor,__expectedUserId,...command}=body as Record<string,unknown>;
  // A stale clinician draft must never gain the authority of a newly signed-in
  // account. This is an intent fence only; the service still revalidates current
  // session, clinician, patient and visit authority in the issuance transaction.
  if(typeof __expectedActor!=='string'||__expectedActor!==session.username||!Number.isSafeInteger(__expectedUserId)||__expectedUserId!==session.userId)return radiologyJson({message:'تغيّر حساب الطبيب أو فُقدت هوية المسودة؛ افتح الطلب من جديد.'},409);
  parsed=parseRadiologyRequest(command);
 } catch(error) { const bounded=bodyErrorResponse(error); if(bounded)return bounded; return radiologyJson({message:'حقول طلب الأشعة غير صالحة.'},400); }
 try { return radiologyJson(await issueRadiologyRequest(session,parsed.key,parsed.draft)); } catch(error) { return radiologyFailure(error); }
}
