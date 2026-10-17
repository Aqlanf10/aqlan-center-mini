import {afterAll,beforeAll,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
import {INVOICE_CURRENCY_RECLASSIFICATION_SQL} from "../../lib/invoice-currency-schema";
import {ensureInvoiceCurrencySchema} from "../../lib/invoice-currency-runtime";
import {readCurrencyReclassificationEvidence} from "../../lib/invoice-currency-evidence";
import type {DbClient} from "../../lib/db";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");let serial=0;
beforeAll(async()=>{await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();});
afterAll(async()=>{await db.resetPoolForTesting();});
async function fixture(client:DbClient){
  const n=++serial;
  const {rows:[patient]}=await client.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic currency evidence') RETURNING id",[`CURRENCY-${n}`]);
  const {rows:[original]}=await client.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES($1,$2,2500,0,'YER','cancelled','synthetic') RETURNING id",[`CUR-OLD-${n}`,patient.id]);
  const {rows:[corrected]}=await client.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES($1,$2,250000,0,'SAR','open','synthetic') RETURNING id",[`CUR-NEW-${n}`,patient.id]);
  const {rows:[shift]}=await client.query("INSERT INTO cashier_shifts(opened_by) VALUES('synthetic') RETURNING id");
  for(const [i,amount] of [70000,10000,10000].entries())await client.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,$4,'payment',$5,'SAR',410,$6,'YER','cash','synthetic')",[`CUR-${n}-${i}`,patient.id,original.id,shift.id,amount,amount/100*410]);
  await client.query("INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,'payment',100,'YER',1,100,'YER','cash','synthetic')",[`CUR-${n}-UNALLOCATED`,patient.id,shift.id]);
  const {rows:before}=await client.query("SELECT to_jsonb(p) AS receipt FROM payments p WHERE patient_id=$1 ORDER BY id",[patient.id]);
  const {rows:[correction]}=await client.query("INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by) VALUES($1,'SAR','YER',$2,$3,$4,$5,'Synthetic currency correction','synthetic') RETURNING id",[patient.id,original.id,corrected.id,`currency-proof-${n}`,"a".repeat(64)]);
  await client.query("INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2::jsonb)",[correction.id,JSON.stringify({patientId:patient.id,currency:"SAR",idempotencyKey:`currency-proof-${n}`,createdBy:"synthetic",original:{id:original.id,patientId:patient.id,baseCurrency:"YER"},corrected:{id:corrected.id,patientId:patient.id,baseCurrency:"SAR"}})]);
  return {patient,original,corrected,correction,shift,before,n};
}
async function document(client:DbClient,f:Awaited<ReturnType<typeof fixture>>,coverage=true){
  const {rows:[doc]}=await client.query("INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids) VALUES($1,$2,'YER','SAR',$3) RETURNING id",[f.correction.id,f.patient.id,[f.original.id]]);
  if(coverage)await client.query("INSERT INTO invoice_settlement_reclassification_events(reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot) SELECT $1,id,1,base_amount_minor,amount_minor,to_jsonb(p) FROM payments p WHERE invoice_id=$2",[doc.id,f.original.id]);
  return doc;
}
it("registers the exact 0063 contract and preserves its successor guard on repeated startup",async()=>{
  expect(INVOICE_CURRENCY_RECLASSIFICATION_SQL).toBe(readFileSync("migrations/0063_invoice_currency_reclassification.sql","utf8"));
  await ensureInvoiceCurrencySchema(db.getPool());
  const {rows}=await db.getPool().query("SELECT name,adopted FROM schema_migrations WHERE version='0063'");
  expect(rows).toEqual([{name:"invoice_currency_reclassification",adopted:false}]);
});
it.each(["missing-document","missing-events"])("rejects incomplete evidence: %s",async mode=>{
  const client=await db.getPool().connect();try{await client.query("BEGIN");const f=await fixture(client);if(mode==="missing-events")await document(client,f,false);
    await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow(/coverage incomplete/);
  }finally{await client.query("ROLLBACK");client.release();}
});
it("proves each SAR receipt, excludes independent YER credit, follows a partial refund once, and never rewrites cash",async()=>{
  const client=await db.getPool().connect();try{await client.query("BEGIN");const f=await fixture(client),doc=await document(client,f);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const {rows:[totals]}=await client.query("SELECT sum(source_minor*direction)::text AS source,sum(target_minor*direction)::text AS target FROM invoice_settlement_reclassification_events WHERE reclassification_id=$1",[doc.id]);
    expect((await readCurrencyReclassificationEvidence(client,f.patient.id)).map(row=>row.targetMinor)).toEqual([70000,10000,10000]);
    expect(totals).toEqual({source:"369000",target:"90000"});expect(250000-Number(totals.target)).toBe(160000);
    expect((await client.query("SELECT to_jsonb(p) AS receipt FROM payments p WHERE patient_id=$1 ORDER BY id",[f.patient.id])).rows).toEqual(f.before);
    const originalId=f.before[0].receipt.id;
    await client.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,reversal_of_id) VALUES($1,$2,$3,$4,'refund',5000,'SAR',410,20500,'YER','cash','synthetic',$5)",[`CUR-${f.n}-REFUND`,f.patient.id,f.original.id,f.shift.id,originalId]);
    expect((await readCurrencyReclassificationEvidence(client,f.patient.id)).reduce((sum,row)=>sum+row.targetMinor*row.direction,0)).toBe(85000);
    expect((await client.query("SELECT count(*)::int AS n,sum(target_minor*direction)::text AS target FROM invoice_settlement_reclassification_events WHERE reclassification_id=$1",[doc.id])).rows).toEqual([{n:4,target:"85000"}]);
    expect((await client.query("SELECT to_jsonb(p) AS receipt FROM payments p WHERE patient_id=$1 ORDER BY id LIMIT 4",[f.patient.id])).rows).toEqual(f.before);
  }finally{await client.query("ROLLBACK");client.release();}
});
it.each(["UPDATE invoice_settlement_reclassifications SET target_currency=target_currency", "DELETE FROM invoice_settlement_reclassification_events", "DELETE FROM payments"])("rejects destructive evidence mutations: %s",async sql=>{
  const client=await db.getPool().connect();try{await client.query("BEGIN");const f=await fixture(client);await document(client,f);
    await expect(client.query(sql)).rejects.toThrow(/append-only/);
  }finally{await client.query("ROLLBACK");client.release();}
});
it.each(["missing-event","changed-cash","changed-source","changed-owner"])("reader rejects imported evidence corruption: %s",async fault=>{
  const client=await db.getPool().connect();try{await client.query("BEGIN");const f=await fixture(client),doc=await document(client,f);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");await client.query("SET LOCAL session_replication_role='replica'");
    if(fault==="missing-event")await client.query("DELETE FROM invoice_settlement_reclassification_events WHERE payment_id=$1",[f.before[0].receipt.id]);
    if(fault==="changed-cash")await client.query("UPDATE payments SET amount_minor=amount_minor+1 WHERE id=$1",[f.before[0].receipt.id]);
    if(fault==="changed-source")await client.query("UPDATE invoice_settlement_reclassifications SET source_invoice_ids=ARRAY[$2::int] WHERE id=$1",[doc.id,f.corrected.id]);
    if(fault==="changed-owner")await client.query("UPDATE invoice_corrections SET currency='YER' WHERE id=$1",[f.correction.id]);
    await expect(readCurrencyReclassificationEvidence(client,f.patient.id)).rejects.toThrow(/إثبات/);
  }finally{await client.query("ROLLBACK");client.release();}
});
it("rejects duplicate event allocation and ordinary new receipts aimed at retired currency lineage",async()=>{
  const client=await db.getPool().connect();try{await client.query("BEGIN");const f=await fixture(client),doc=await document(client,f);
    await client.query("SAVEPOINT duplicate_event");
    await expect(client.query("INSERT INTO invoice_settlement_reclassification_events(reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot) SELECT $1,id,1,base_amount_minor,amount_minor,to_jsonb(p) FROM payments p WHERE id=$2",[doc.id,f.before[0].receipt.id])).rejects.toThrow(/unique/);
    await client.query("ROLLBACK TO SAVEPOINT duplicate_event");
    await expect(client.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,$4,'payment',100,'SAR',410,410,'YER','cash','synthetic')",[`CUR-${f.n}-LATE`,f.patient.id,f.original.id,f.shift.id])).rejects.toThrow(/current corrected invoice/);
  }finally{await client.query("ROLLBACK");client.release();}
});
