import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openInventoryPurchaseFixture } from "./_inventory-purchase-fixture";
import { INVOICE_ACTION_HISTORY_TABLES, ProtectedInvoiceActionHistoryError, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../../lib/clinic-reset";

let fixture: Awaited<ReturnType<typeof openInventoryPurchaseFixture>>;
beforeEach(async()=>{fixture=await openInventoryPurchaseFixture();},180000);
afterEach(async()=>{await fixture?.close();});
const q=(sql:string,values:unknown[]=[])=>fixture.pool.query(sql,values);
const reset={actor:"synthetic-invoice-reset",actorRole:"admin"};
async function owners(){
 const {rows:[user]}=await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-invoice-reset','Synthetic','not-a-login','admin') RETURNING id");
 const {rows:[patient]}=await q("INSERT INTO patients(patient_number,full_name) VALUES('SYN-INVOICE-RESET','Synthetic reset') RETURNING id");
 const ids:number[]=[];
 for(const [i,total] of [[1,10000],[2,2000]]){
  const {rows:[invoice]}=await q("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,idempotency_key) VALUES($1,$2,$3,0,'YER','synthetic-invoice-reset',$4) RETURNING id",[`SYN-RESET-${i}`,patient.id,total,i===2?'synthetic-add-reset-key':null]);
  ids.push(invoice.id);
  await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic',1,$2,$2)",[invoice.id,total]);
 }
 return {userId:user.id,patientId:patient.id,original:ids[0],additional:ids[1]};
}
async function insertHistory(table:string,owner:Awaited<ReturnType<typeof owners>>){
 const {userId,patientId,original,additional}=owner, hash="a".repeat(64);
 if(table==='invoice_archive_events')await q(`INSERT INTO invoice_archive_events(invoice_id,patient_id,invoice_number,invoice_created_at,currency,version,action,reason,idempotency_key,request_hash,actor_user_id,actor)
 SELECT id,patient_id,invoice_number,created_at,base_currency,1,'archive','Synthetic reset archive','synthetic-reset-archive',$2,$3,'synthetic-invoice-reset' FROM invoices WHERE id=$1`,[original,hash,userId]);
 if(table==='invoice_archive_rejections')await q("INSERT INTO invoice_archive_rejections(idempotency_key,invoice_id,actor_user_id,request_hash,code,message) VALUES('synthetic-reset-reject',$1,$2,$3,'period_locked','Synthetic refusal')",[original,userId,hash]);
 if(table==='invoice_service_additions'){
  const receipt={originalInvoiceId:original,additionalInvoiceId:additional,additionalInvoiceNumber:'SYN-RESET-2',patientId,currency:'YER',idempotencyKey:'synthetic-add-reset-key',requestHash:hash,createdBy:'synthetic-invoice-reset',addedNetMinor:2000,cashMovementMinor:0};
  await q("INSERT INTO invoice_service_additions(original_invoice_id,additional_invoice_id,patient_id,currency,source_hash,idempotency_key,request_hash,actor_id,created_by,reason,receipt) VALUES($1,$2,$3,'YER',$4,'synthetic-add-reset-key',$4,$5,'synthetic-invoice-reset','Synthetic addition',$6)",[original,additional,patientId,hash,userId,JSON.stringify(receipt)]);
 }
 if(table==='invoice_service_addition_rejections')await q("INSERT INTO invoice_service_addition_rejections(idempotency_key,original_invoice_id,actor_id,request_hash,expected_source_hash,observed_source_hash) VALUES('synthetic-reset-add-reject',$1,$2,$3,$3,$3)",[original,userId,hash]);
}
async function state(){return Promise.all(['patients','invoices','invoice_items','audit_log',...INVOICE_ACTION_HISTORY_TABLES].map(async table=>[table,(await q(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows]));}
it('classifies every invoice action table as retained and permits empty reset with real snapshot',async()=>{
 for(const table of INVOICE_ACTION_HISTORY_TABLES){expect(RESET_KEEP_TABLES).toContain(table);expect(RESET_WIPE_TABLES).not.toContain(table);}
 let sql='';
 const result=await fixture.db.resetClinicData(reset,async client=>{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{for await(const line of fixture.db.backupSnapshotSqlLines(client))sql+=line;}finally{await client.query('ROLLBACK');}
  return {ok:true,backupId:'synthetic-owned-snapshot'};
 });
 expect(result.ok).toBe(true);
 for(const table of INVOICE_ACTION_HISTORY_TABLES)expect(sql).toContain(`-- ${table} (0)`);
 expect((await q('SELECT id FROM patients')).rows).toEqual([]);
});
it.each(INVOICE_ACTION_HISTORY_TABLES)('refuses %s history before backup or mutation',async table=>{
 await insertHistory(table,await owners());const before=await state();
 const backup=vi.fn(async()=>({ok:true as const,backupId:'must-not-run'}));
 await expect(fixture.db.resetClinicData(reset,backup)).rejects.toBeInstanceOf(ProtectedInvoiceActionHistoryError);
 expect(backup).not.toHaveBeenCalled();expect(await state()).toEqual(before);
 await expect(q(`TRUNCATE ${table}`)).rejects.toThrow();expect(await state()).toEqual(before);
});
it.each(INVOICE_ACTION_HISTORY_TABLES)('does not permit empty %s truncation at repeatable read',async table=>{
 const client=await fixture.pool.connect();
 try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await expect(client.query(`TRUNCATE ${table}`)).rejects.toThrow();}
 finally{await client.query('ROLLBACK');client.release();}
});
it('waits for in-flight evidence, then refuses reset without backup or deletion',async()=>{
 const owner=await owners(),writer=await fixture.pool.connect();
 const backup=vi.fn(async()=>({ok:true as const,backupId:'must-not-run'}));
 let resetting:Promise<unknown>|undefined;
 try{
  await writer.query('BEGIN');
  await writer.query("INSERT INTO invoice_archive_rejections(idempotency_key,invoice_id,actor_user_id,request_hash,code,message) VALUES('synthetic-concurrent-reject',$1,$2,$3,'period_locked','Synthetic concurrent refusal')",[owner.original,owner.userId,'c'.repeat(64)]);
  resetting=fixture.db.resetClinicData(reset,backup).then(value=>({value}),error=>({error}));
  let waiting=false;
  for(const deadline=Date.now()+5000;Date.now()<deadline;){
   const {rows:[lock]}=await q("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='invoice_archive_rejections'::regclass AND mode='ExclusiveLock' AND NOT granted) AS waiting");
   if(lock.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(waiting).toBe(true);expect(backup).not.toHaveBeenCalled();
  await writer.query('COMMIT');
  expect(await resetting).toMatchObject({error:expect.any(ProtectedInvoiceActionHistoryError)});
  expect(backup).not.toHaveBeenCalled();
  expect((await q('SELECT id FROM patients')).rows).toHaveLength(1);
  expect((await q('SELECT idempotency_key FROM invoice_archive_rejections')).rows).toEqual([{idempotency_key:'synthetic-concurrent-reject'}]);
 }finally{await writer.query('ROLLBACK');writer.release();await resetting;}
});
