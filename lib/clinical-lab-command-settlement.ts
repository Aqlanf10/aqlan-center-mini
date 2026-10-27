import {getPool} from "./db";
import type {SessionPayload} from "./auth";
import {labWorkIntentSupported,LabWorkIntentError,recordRejectedLabWorkCommandInTransaction} from "./lab-work-intent-db";
/** Only called after a recognized source transaction refusal/rollback. Unknown failures stay unresolved.
 * Uses the same patient -> visit -> actor/key fence as apply; a winning applied receipt is never replaced. */
export async function settleRejectedClinicalLabCommand(input:{patientId:number;visitId:number;session:SessionPayload;requestKey:string;requestHash:string;code:string}){
 const client=await getPool().connect();
 try{
  await client.query("BEGIN");
  if(!await labWorkIntentSupported(client))throw new LabWorkIntentError("schema_unavailable",503);
  await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE NOWAIT",[input.patientId]);
  const source=(await client.query<{patient_id:number|null}>("SELECT patient_id FROM visits WHERE id=$1 FOR UPDATE NOWAIT",[input.visitId])).rows[0];
  if(source?.patient_id!==input.patientId)throw new LabWorkIntentError("source_changed",409);
  const result=await recordRejectedLabWorkCommandInTransaction(client,{patientId:input.patientId,sourceKind:"visit",sourceId:input.visitId,session:input.session,requestKey:input.requestKey,requestHash:input.requestHash},input.code);
  await client.query("COMMIT");return result;
 }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}
