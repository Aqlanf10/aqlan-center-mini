import { readJsonBody, bodyErrorResponse } from '@/lib/http-body';
import { readSessionPayload } from '@/lib/session';
import { parseRadiologyRequest } from '@/lib/radiology-request';
import { issueRadiologyRequest } from '@/lib/radiology-request-service';
import { radiologyJson, radiologyFailure, radiologyRoleDenial } from '@/lib/radiology-http';
export async function POST(request: Request) {
 const session=await readSessionPayload(); if(!session?.credentialVersion) return radiologyJson({message:'سجّل الدخول من جديد.'},401);
 const denied=radiologyRoleDenial(session,true);if(denied)return denied;
 let parsed; try { parsed=parseRadiologyRequest(await readJsonBody(request,16000)); } catch(error) { const bounded=bodyErrorResponse(error); if(bounded)return bounded; return radiologyJson({message:'حقول طلب الأشعة غير صالحة.'},400); }
 try { return radiologyJson(await issueRadiologyRequest(session,parsed.key,parsed.draft)); } catch(error) { return radiologyFailure(error); }
}
