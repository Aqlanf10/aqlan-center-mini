import type {SessionPayload} from "./auth";
import {ensureSchema,getPool,type DbClient} from "./db";
import {readLegacyStaffSchema} from "./legacy-staff-boundary";
import {revalidateLegacySessionReadOnlySnapshot} from "./session";

/** An owning read-only boundary, NOT mutation admission. The session comes from
 * the verified server authentication path, never request JSON. No client/pool
 * fallback or caller-selected isolation is accepted. Domain policy sees only
 * the freshly revalidated snapshot projection; it cannot replace that identity.
 * Preflight -> ensureSchema remains a maintenance-only initialization gap:
 * installers must quiesce/drain and use the matching exclusive lifecycle fence. */
export async function withLegacyStaffReadOnlySnapshot<T>(
 session:SessionPayload,
 policy:{allows:(current:SessionPayload)=>boolean;unauthorized:()=>Error;expired?:()=>Error},
 read:(client:DbClient,current:SessionPayload)=>Promise<T>,
):Promise<T>{
 if(await readLegacyStaffSchema(getPool())!=="base")throw policy.unauthorized();
 await ensureSchema();
 const client=await getPool().connect();
 const fence="aqlan.canonical.identity.substrate.v1:public";
 let locked=false,began=false,destroy=false;
 try{
  try{await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))",[fence]);locked=true;}
  catch(error){destroy=true;throw error;}
  began=true;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const current=await revalidateLegacySessionReadOnlySnapshot(session,client);
  if(!current||!policy.allows(current))throw policy.unauthorized();
  const result=await read(client,current);
  if(session.expiresAt<=Date.now())throw (policy.expired??policy.unauthorized)();
  await client.query("COMMIT");began=false;return result;
 }catch(error){
  if(began){try{await client.query("ROLLBACK");began=false;}catch{destroy=true;}}
  throw error;
 }finally{
  if(locked){try{
   const {rows}=await client.query<{unlocked:boolean}>("SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked",[fence]);
   if(rows.length!==1||rows[0].unlocked!==true)destroy=true;
  }catch{destroy=true;}}
  client.release(destroy);
 }
}
