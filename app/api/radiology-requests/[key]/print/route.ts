import { readSessionPayload } from '@/lib/session';
import { readJsonBody, bodyErrorResponse } from '@/lib/http-body';
import { RADIOLOGY_UUID } from '@/lib/radiology-request';
import { authorizeRadiologyPrint } from '@/lib/radiology-request-service';
import { radiologyJson, radiologyFailure } from '@/lib/radiology-http';
export async function POST(request:Request,context:{params:Promise<{key:string}>}) {
 const session=await readSessionPayload();if(!session?.credentialVersion)return radiologyJson({message:'سجّل الدخول من جديد.'},401);
 const {key}=await context.params;let patientId:number;
 try{const body=await readJsonBody<{patientId?:unknown}>(request,1024);if(!body||Object.keys(body).some(k=>k!=='patientId')||typeof body.patientId!=='number'||!Number.isSafeInteger(body.patientId)||body.patientId<=0||body.patientId>2147483647||!RADIOLOGY_UUID.test(key))throw new Error();patientId=body.patientId;}catch(error){const bounded=bodyErrorResponse(error);return bounded??radiologyJson({message:'سياق الطباعة غير صالح.'},400);}
 try{return radiologyJson(await authorizeRadiologyPrint(session,key,patientId));}catch(error){return radiologyFailure(error);}
}
