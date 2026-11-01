import { readSessionPayload } from '@/lib/session';
import { RADIOLOGY_UUID } from '@/lib/radiology-request';
import { recoverRadiologyRequest } from '@/lib/radiology-request-service';
import { radiologyId, radiologyJson, radiologyFailure } from '@/lib/radiology-http';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{key:string}>}) {
 const session=await readSessionPayload(); if(!session?.credentialVersion) return radiologyJson({message:'سجّل الدخول من جديد.'},401);
 const {key}=await context.params; const query=new URL(request.url).searchParams; let patientId:number,visitId:number|null;
 try {if(!RADIOLOGY_UUID.test(key)) throw new Error(); patientId=radiologyId(query.get('patientId'));visitId=query.has('visitId')?radiologyId(query.get('visitId')):null;} catch {return radiologyJson({message:'مفتاح أو نطاق الطلب غير صالح.'},400);}
 try{return radiologyJson(await recoverRadiologyRequest(session,key,patientId,visitId));}catch(error){return radiologyFailure(error);}
}
