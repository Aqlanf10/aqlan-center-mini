import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv, createIsolatedDatabase, adminClient } from "./_setup";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { DEBT_INSTALLMENTS_SQL } from "../../lib/debt-installments-schema";
import { prepareBackupSql } from "../../lib/restore/sql.mjs";
import type { SessionPayload } from "../../lib/auth";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
const schedules=await import("../../lib/debt-installments-db");
const auth=await import("../../lib/auth");
let session: SessionPayload;let patientId:number;let invoiceId:number;let oldInvoice:unknown;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
const terms={mode:"installments",installments:[{dueDate:"2026-10-12",amountMinor:20000,kind:"down_payment"},{dueDate:"2026-11-12",amountMinor:40000,kind:"installment"}]};
const target=()=>({patientId,currency:"SAR" as const,invoiceId,openingCurrency:null});
const input=(key:string,version=0)=>({target:target(),terms,expectedVersion:version,expectedRemainingMinor:60000,reason:"Synthetic exact debt schedule",idempotencyKey:key,session});
beforeAll(async()=>{
  await dropPublicSchema(process.env.DATABASE_URL!);
  const files=(await loadMigrationFiles()).filter(file=>file.version<="0059");expect(files.at(-1)?.filename).toBe("0059_invoice_debt_installments.sql");
  expect(files.filter(f=>Number(f.version)>43).map(f=>f.version)).toEqual(["0045","0046","0048","0049","0050","0051","0052","0056","0057","0058","0059"]);
  await migrate(db.getPool(),{apply:true,files:files.filter(f=>Number(f.version)<=43)});
  patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES('DEBT-SYN','Synthetic schedule') RETURNING id"))[0].id;
  invoiceId=(await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES('DEBT-OLD', $1,'SAR',60000,0,'synthetic') RETURNING id",[patientId]))[0].id;
  oldInvoice=(await q("SELECT to_jsonb(i) AS facts FROM invoices i WHERE id=$1",[invoiceId]))[0].facts;
  await migrate(db.getPool(),{apply:true,files});await db.ensureSchema();
  const password=await auth.hashPassword("synthetic-schedule-session-password");
  const id=(await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('schedule-owner','Synthetic schedule owner',$1,'admin',TRUE) RETURNING id",[password]))[0].id;
  session={userId:id,username:"schedule-owner",role:"admin",expiresAt:Date.now()+3_600_000,credentialVersion:auth.sessionCredentialVersion(password)};
},180_000);
afterAll(async()=>{await db.resetPoolForTesting();});

describe("0059 existing-debt allocation storage",()=>{
  it("keeps migration/bootstrap byte-identical, applies with gaps and leaves prior invoice facts intact",async()=>{
    expect(readFileSync("migrations/0059_invoice_debt_installments.sql","utf8")).toBe(DEBT_INSTALLMENTS_SQL);
    expect((await q("SELECT to_jsonb(i) AS facts FROM invoices i WHERE id=$1",[invoiceId]))[0].facts).toEqual(oldInvoice);
    expect((await q("SELECT version FROM schema_migrations ORDER BY version")).map(r=>r.version).at(-1)).toBe("0063");
  });
  it("creates exact terms without a second invoice or receipt; exact retry returns the same version",async()=>{
    const first=await schedules.saveDebtRepayment(input("debt-create-exact"));
    expect(first.version).toBe(1);expect(first.replayed).toBe(false);
    expect(await schedules.saveDebtRepayment(input("debt-create-exact"))).toEqual({...first,replayed:true});
    await expect(schedules.saveDebtRepayment({...input("debt-create-exact"),reason:"Changed command"})).rejects.toMatchObject({code:"conflict"});
    expect((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[patientId]))[0].n).toBe(1);
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[patientId]))[0].n).toBe(0);
    expect((await schedules.listDebtRepayments(patientId,"2026-10-13"))[0]).toMatchObject({version:1,remainingMinor:60000,collectedMinor:0,requiresReview:false,progress:{overdueMinor:20000}});
  });
  it("enforces exact sum, dates and immutable history in PostgreSQL",async()=>{
    for(const invalid of [null,{mode:"installments",installments:[]},{...terms,installments:[{...terms.installments[0],amountMinor:60001}]},{...terms,installments:[{...terms.installments[0],amountMinor:60000,dueDate:"2026-02-30"}]}])
      expect((await q("SELECT aqlan_debt_terms_valid($1::jsonb,60000) IS TRUE AS valid",[JSON.stringify(invalid)]))[0].valid).toBe(false);
    await expect(q("UPDATE debt_repayment_revisions SET reason='silent edit'")).rejects.toThrow("append-only");
    await expect(q("DELETE FROM debt_repayment_revisions")).rejects.toThrow("append-only");
    await expect(q("INSERT INTO debt_repayment_arrangements(patient_id,currency,created_by) VALUES($1,'SAR','synthetic')",[patientId])).rejects.toThrow("debt_repayment_target_check");
  });
  it("serializes two revisions and preserves original terms",async()=>{
    const result=await Promise.allSettled([schedules.saveDebtRepayment(input("debt-revise-a",1)),schedules.saveDebtRepayment(input("debt-revise-b",1))]);
    expect(result.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(result.filter(r=>r.status==="rejected")).toHaveLength(1);
    expect((await schedules.listDebtRepayments(patientId,"2026-10-13"))[0].history).toHaveLength(2);
    await q("UPDATE users SET is_active=FALSE WHERE id=$1",[session.userId]);
    try{await expect(schedules.saveDebtRepayment(input("debt-revise-revoked",2))).rejects.toMatchObject({code:"unauthorized"});}
    finally{await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]);}
  });
  it("cancels the schedule without cancelling debt and keeps exact original replay",async()=>{
    const before=(await q("SELECT to_jsonb(i) AS facts FROM invoices i WHERE id=$1",[invoiceId]))[0].facts;
    await schedules.saveDebtRepayment({...input("debt-cancel-exact",2),cancel:true});
    expect((await schedules.listDebtRepayments(patientId,"2026-10-13"))[0]).toMatchObject({version:3,status:"cancelled",remainingMinor:60000});
    expect((await q("SELECT to_jsonb(i) AS facts FROM invoices i WHERE id=$1",[invoiceId]))[0].facts).toEqual(before);
    expect(await schedules.saveDebtRepayment(input("debt-create-exact"))).toMatchObject({version:1,replayed:true});
  });
  it("round-trips immutable schedules and prior invoices through canonical backup SQL",async()=>{
    const prior=await q("SELECT to_jsonb(r) AS facts FROM debt_repayment_revisions r ORDER BY id");
    const invoices=await q("SELECT to_jsonb(i) AS facts FROM invoices i ORDER BY id");
    const chunks:string[]=[];for await(const chunk of db.backupSnapshotSqlLines(db.getPool()))chunks.push(chunk);
    const sql=chunks.join("");expect(sql.indexOf("-- debt_repayment_revisions (")).toBeGreaterThan(sql.indexOf("-- debt_repayment_arrangements ("));
    const name="aqlan_debt_installments_restore_test";
    const url=await createIsolatedDatabase(name);const restored=new Pool({connectionString:url,ssl:false});
    try{
      await migrate(restored as unknown as Parameters<typeof migrate>[0],{apply:true,files:await loadMigrationFiles()});
      const registry=(await restored.query("SELECT to_jsonb(m)::text AS facts FROM schema_migrations m ORDER BY version")).rows;
      // Fresh migrated target: preserve its registry and immutable history guards.
      await restored.query(prepareBackupSql(sql).sql);
      expect((await restored.query("SELECT to_jsonb(m)::text AS facts FROM schema_migrations m ORDER BY version")).rows).toEqual(registry);
      expect((await restored.query("SELECT to_jsonb(r) AS facts FROM debt_repayment_revisions r ORDER BY id")).rows).toEqual(prior);
      expect((await restored.query("SELECT to_jsonb(i) AS facts FROM invoices i ORDER BY id")).rows).toEqual(invoices);
    }finally{await restored.end();const admin=adminClient("postgres");await admin.connect();try{await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);}finally{await admin.end();}}
  },120_000);
});
