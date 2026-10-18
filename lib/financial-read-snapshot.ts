import type {DbClient,DbPool} from "./db";

/** PostgreSQL projections must observe invoice, receipt and allocation facts in
 * one snapshot. PGlite has one shared connection; preserve its existing read
 * behavior instead of starting transactions that can commit another caller. */
export async function withFinancialReadSnapshot<T>(pool:DbPool,read:(runner:DbClient|DbPool)=>Promise<T>,sharedLocalConnection=false):Promise<T>{
  if(sharedLocalConnection)return read(pool);
  const client=await pool.connect();let destroy=false;
  try{
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result=await read(client);await client.query("COMMIT");return result;
  }catch(error){
    try{await client.query("ROLLBACK");}catch{destroy=true;}
    throw error;
  }finally{
    client.release(destroy);
  }
}
