import type {DbClient,DbPool} from "./db";

/** PostgreSQL projections share one read-only snapshot and one connection.
 * Serialize reader queries, including Promise.all callers; pg 9 will no longer
 * accept overlapping client.query calls. PGlite retains its shared connection. */
export async function withFinancialReadSnapshot<T>(pool:DbPool,read:(runner:DbClient|DbPool)=>Promise<T>,sharedLocalConnection=false):Promise<T>{
  if(sharedLocalConnection)return read(pool);
  const client=await pool.connect();let destroy=false;
  let open=true,failed=false,firstFailure:unknown;
  let tail:Promise<void>=Promise.resolve();
  const runner:DbClient={
    query(sql,values){
      if(!open)return Promise.reject(new Error("FINANCIAL_SNAPSHOT_CLOSED"));
      const next=tail.then(()=>{
        if(failed)throw firstFailure;
        return client.query(sql,values);
      });
      tail=next.then(()=>undefined,error=>{if(!failed){failed=true;firstFailure=error;}});
      return next;
    },
    release(){throw new Error("FINANCIAL_SNAPSHOT_RELEASE_OWNED");},
  };
  try{
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let result:T;
    try{result=await read(runner);}finally{open=false;await tail;}
    if(failed)throw firstFailure;
    await client.query("COMMIT");return result;
  }catch(error){
    open=false;await tail;
    try{await client.query("ROLLBACK");}catch{destroy=true;}
    throw error;
  }finally{
    client.release(destroy);
  }
}
