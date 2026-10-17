import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
assertRealPostgresUrl();stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_debt_read_snapshot_test");
const db = await import("../../lib/db");let serial=0,shift:number;
const q=(sql:string,values:unknown[]=[])=>db.getPool().query(sql,values);
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function deadline(promise:Promise<void>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Invoice read did not complete")),5000);})]);}finally{clearTimeout(timer);}}
beforeAll(async()=>{await db.ensureSchema();shift=(await q("INSERT INTO cashier_shifts(opened_by) VALUES('synthetic snapshot') RETURNING id")).rows[0].id;},180000);
afterAll(async()=>{vi.restoreAllMocks();await db.resetPoolForTesting();});
describe("computeDebtRows coherent PostgreSQL snapshot (integrated with currency evidence)",()=>{
 it.each(["YER","SAR","USD"] as const)("does not mix old invoices with new %s payments",async currency=>{
  const pid=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic snapshot') RETURNING id",[`SNAP-${++serial}`])).rows[0].id as number;
  const iid=(await q("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,100,0,$3) RETURNING id",[`SNAP-I-${++serial}`,pid,currency])).rows[0].id;
  const invoiceRead=deferred(),releasePayments=deferred(),original=Client.prototype.query;
  const spy=vi.spyOn(Client.prototype,"query").mockImplementation(function(this:Client,...args:unknown[]){
   const sql=typeof args[0]==="string"?args[0].replace(/\s+/g," "):"",values=Array.isArray(args[1])?args[1]:[];
   const scoped=Array.isArray(values[0])&&values[0][0]===pid;
   const invoice=scoped&&sql.includes("GREATEST(0, total_minor - discount_minor)"),payment=scoped&&sql.includes("FROM payments WHERE");
   const invoke=(call:unknown[])=>Reflect.apply(original,this,call);
   if(!invoice&&!payment)return invoke(args);
   const callback=typeof args.at(-1)==="function"?args.at(-1) as (error:unknown,result?:unknown)=>void:null;
   if(callback){const execute=()=>invoke([...args.slice(0,-1),(error:unknown,result:unknown)=>{if(invoice&&!error)invoiceRead.resolve();callback(error,result);}]);
    if(payment){void releasePayments.promise.then(execute).catch(callback);return undefined;}return execute();}
   const execute=async()=>{const result=await invoke(args);if(invoice)invoiceRead.resolve();return result;};return payment?releasePayments.promise.then(execute):execute();
  } as typeof original);
  const sampled=db.computeDebtRows([pid],true);void sampled.catch(()=>undefined);
  const writer=new Client({connectionString:process.env.DATABASE_URL,ssl:false});
  try{await deadline(invoiceRead.promise);await writer.connect();await writer.query("BEGIN");
   await writer.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,100,0,$3)",[`SNAP-I-${++serial}`,pid,currency]);
   await writer.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method) VALUES($1,$2,$3,$4,'payment',40,$5,1,40,'YER','cash')",[`SNAP-P-${++serial}`,pid,iid,shift,currency]);
   await writer.query("COMMIT");releasePayments.resolve();const old=(await sampled).find(row=>row.currency===currency)!,fresh=(await db.computeDebtRows([pid],true)).find(row=>row.currency===currency)!;
   expect(fresh).toMatchObject({billedMinor:200,collectedMinor:40,dueMinor:160});expect(old).toMatchObject({billedMinor:100,collectedMinor:0,dueMinor:100});
  }finally{releasePayments.resolve();await sampled.catch(()=>undefined);spy.mockRestore();await writer.end();}
 });
 it.each(["success","read","commit","rollback"] as const)("releases the snapshot connection after %s",async scenario=>{
  const pool=db.getPool(),client=await pool.connect(),originalQuery=client.query.bind(client),statements:string[]=[],failure=new Error(`synthetic ${scenario} failure`);
  const originalConnect=pool.connect.bind(pool),backendPid=(await originalQuery<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const release=vi.spyOn(client,"release");const query=vi.spyOn(client,"query").mockImplementation((...args:Parameters<typeof client.query>)=>{
   const sql=String(args[0]);statements.push(sql);if((scenario==="read"||scenario==="rollback")&&sql.includes("FROM patients WHERE"))return Promise.reject(failure);
   if(scenario==="commit"&&sql==="COMMIT")return Promise.reject(failure);
   if(scenario==="rollback"&&sql==="ROLLBACK")return Promise.reject(new Error("synthetic rollback failure"));return originalQuery(...args);
  });
  const connect=vi.spyOn(pool,"connect").mockResolvedValueOnce(client),poolQuery=vi.spyOn(pool,"query");
  try{if(scenario==="success")await expect(db.computeDebtRows(null,true)).resolves.toBeInstanceOf(Array);else await expect(db.computeDebtRows(null,true)).rejects.toBe(failure);
   expect(connect).toHaveBeenCalledTimes(1);expect(poolQuery).not.toHaveBeenCalled();expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
   // Six original inputs plus two batch evidence reads, all on the same client.
   expect(statements.filter(sql=>sql.trim().startsWith("SELECT"))).toHaveLength(scenario==="read"||scenario==="rollback"?1:8);
   expect(statements.at(-1)).toBe(scenario==="success"?"COMMIT":"ROLLBACK");expect(release).toHaveBeenCalledTimes(1);
   if(scenario==="rollback"){
    const next=await originalConnect();let nextPid:number;
    try{nextPid=(await next.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;}
    finally{await originalQuery("ROLLBACK").catch(()=>undefined);next.release();}
    expect(nextPid).not.toBe(backendPid);expect(release).toHaveBeenNthCalledWith(1,true);
    await expect(db.computeDebtRows(null,true)).resolves.toBeInstanceOf(Array);
   }
  }finally{connect.mockRestore();poolQuery.mockRestore();query.mockRestore();release.mockRestore();}
 });
 it("does not acquire a snapshot connection for an empty patient scope",async()=>{const connect=vi.spyOn(db.getPool(),"connect");try{await expect(db.computeDebtRows([])).resolves.toEqual([]);expect(connect).not.toHaveBeenCalled();}finally{connect.mockRestore();}});
});
