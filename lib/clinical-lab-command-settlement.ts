import {getPool,type DbClient} from "./db";
import {labWorkIntentSupported,LabWorkIntentError,recordRejectedLabWorkCommandInTransaction,type LabActorSource} from "./lab-work-intent-db";
/** Only called after a recognized source transaction refusal/rollback. Unknown failures stay unresolved.
 * Uses the same patient -> visit -> actor/key fence as apply; a winning applied receipt is never replaced. */
export async function settleRejectedClinicalLabCommand(input:{patientId:number;visitId:number;session:LabActorSource;requestKey:string;requestHash:string;code:string}){
 const client=await getPool().connect();
 try{
  await client.query("BEGIN");
  const result=await settleRejectedClinicalLabCommandOn(client,input);
  await client.query("COMMIT");return result;
 }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}
/** The same settlement on a caller-owned transaction (M2 slice 87: inside a freshly admitted
 * canonical operation that re-proves the actor's authority). */
export async function settleRejectedClinicalLabCommandOn(client:DbClient,input:{patientId:number;visitId:number;session:LabActorSource;requestKey:string;requestHash:string;code:string}){
 {
  if(!await labWorkIntentSupported(client))throw new LabWorkIntentError("schema_unavailable",503);
  await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE NOWAIT",[input.patientId]);
  const source=(await client.query<{patient_id:number|null}>("SELECT patient_id FROM visits WHERE id=$1 FOR UPDATE NOWAIT",[input.visitId])).rows[0];
  if(source?.patient_id!==input.patientId)throw new LabWorkIntentError("source_changed",409);
  return recordRejectedLabWorkCommandInTransaction(client,{patientId:input.patientId,sourceKind:"visit",sourceId:input.visitId,session:input.session,requestKey:input.requestKey,requestHash:input.requestHash},input.code);
 }
}
