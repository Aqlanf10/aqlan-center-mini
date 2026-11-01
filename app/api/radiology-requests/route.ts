import { readJsonBody, bodyErrorResponse } from '@/lib/http-body';
import { requireSession } from '@/lib/session';
import { parseRadiologyRequest } from '@/lib/radiology-request';
import { issueRadiologyRequest } from '@/lib/radiology-request-service';
import { radiologyJson, radiologyFailure } from '@/lib/radiology-http';
export async function POST(request: Request) {
 const session=await requireSession(); if(!session) return radiologyJson({message:'سجّل الدخول من جديد.'},401);
 let parsed; try { parsed=parseRadiologyRequest(await readJsonBody(request,16000)); } catch(error) { const bounded=bodyErrorResponse(error); if(bounded)return bounded; return radiologyJson({message:'حقول طلب الأشعة غير صالحة.'},400); }
 try { return radiologyJson(await issueRadiologyRequest(session,parsed.key,parsed.draft)); } catch(error) { return radiologyFailure(error); }
}
