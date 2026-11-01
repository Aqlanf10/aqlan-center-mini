import { readSessionPayload } from '@/lib/session';
import { RADIOLOGY_UUID } from '@/lib/radiology-request';
import { listRadiologyRequests, radiologyRequestOptions } from '@/lib/radiology-request-service';
import { radiologyId, radiologyJson, radiologyFailure } from '@/lib/radiology-http';
export const dynamic='force-dynamic';
export async function GET(request: Request, context:{params:Promise<{id:string}>}) {
 const session=await readSessionPayload(); if(!session?.credentialVersion) return radiologyJson({message:'سجّل الدخول من جديد.'},401);
 const query=new URL(request.url).searchParams; let patientId:number,visitId:number|null;
 const before=query.get('before');
 try {patientId=radiologyId((await context.params).id); visitId=query.has('visitId')?radiologyId(query.get('visitId')):null; if(before&&!RADIOLOGY_UUID.test(before)) throw new Error();} catch {return radiologyJson({message:'رقم الملف أو مؤشر الصفحة غير صالح.'},400);}
 try { return radiologyJson(query.get('mode')==='options'?await radiologyRequestOptions(session,patientId,visitId):await listRadiologyRequests(session,patientId,visitId,before)); } catch(error) {return radiologyFailure(error);}
}
