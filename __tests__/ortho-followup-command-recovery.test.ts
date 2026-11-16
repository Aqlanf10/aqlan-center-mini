import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SessionPayload } from "../lib/auth";
import type { FollowupCoverageCommand } from "../lib/ortho-followup-coverage";
vi.stubEnv("USE_LOCAL_DB","true");vi.stubEnv("NODE_ENV","test");vi.stubEnv("RAILWAY_PROJECT_ID","");
vi.stubEnv("SESSION_SECRET","synthetic-followup-authority-test-only-0123456789");
const db=await import("../lib/db");
const {sessionCredentialVersion}=await import("../lib/auth");
const coverage=await import("../lib/ortho-followup-coverage-db");
const q=async(sql:string,args:unknown[]=[]) => (await db.getPool().query(sql,args)).rows;
let admin:SessionPayload,provider:number,service:number;
let seq=0;
async function fixture(){
  const n=++seq;
  const patient=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic recovery patient') RETURNING id",[`SYN-REC-${n}`]))[0].id;
  const ortho=(await q("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic-admin') RETURNING id",[patient]))[0].id;
  const clinical=(await q("INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic ortho','both',$2,'synthetic-admin') RETURNING id",[patient,ortho]))[0].id;
  const plan=(await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,consent_at,consent_by) VALUES($1,'Synthetic invoice-origin agreement',250000,'YER',NOW(),'synthetic-admin') RETURNING id",[patient]))[0].id;
  const invoice=(await q("INSERT INTO invoices(patient_id,invoice_number,total_minor,base_currency) VALUES($1,$2,250000,'YER') RETURNING id",[patient,`SYN-REC-INV-${n}`]))[0].id;
  const item=(await q(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count)
    VALUES($1,$2,$3,'Synthetic ortho treatment','ortho',$4,1,250000,'billed',$5,$5,'invoice',12) RETURNING id`,[plan,clinical,service,provider,invoice]))[0].id;
  await q(`INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,source_type,source_id,plan_item_id)
    VALUES($1,$2,$3,'Synthetic ortho treatment',1,250000,250000,'plan_item',$4::bigint,$4::int)`,[invoice,service,provider,item]);
  return {patient,ortho,clinical,plan,invoice,item};
}
async function command(f:Awaited<ReturnType<typeof fixture>>,decision:"included"|"excluded"="included"){
  const read=await coverage.readFollowupCoverage({session:admin,patientId:f.patient,orthoCaseId:f.ortho});
  expect(read.sources).toHaveLength(1);
  const {fingerprint,invoiceNumber:_n,serviceName:_s,...source}=read.sources[0];
  return {schemaVersion:1,commandId:randomUUID(),expectedRevisionId:read.current?.id??null,source,expectedSourceFingerprint:fingerprint,scope:"routine_adjustments",decision,reason:"Synthetic explicitly agreed routine followups"} satisfies FollowupCoverageCommand;
}
async function append(f:Awaited<ReturnType<typeof fixture>>,c:FollowupCoverageCommand,session=admin){return coverage.appendFollowupCoverage({session,patientId:f.patient,orthoCaseId:f.ortho,command:c});}
beforeAll(async()=>{
  await db.ensureSchema();
  const user=(await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-recovery-admin','Synthetic admin','synthetic-hash','admin') RETURNING id"))[0];
  admin={userId:user.id,username:"synthetic-recovery-admin",role:"admin",expiresAt:Date.now()+300_000,credentialVersion:sessionCredentialVersion("synthetic-hash")};
  provider=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic treating provider','doctor') RETURNING id"))[0].id;
  service=(await q("INSERT INTO services(name,category,price_minor) VALUES('Synthetic ortho treatment','ortho',250000) RETURNING id"))[0].id;
},90_000);
afterAll(async()=>{await db.resetPoolForTesting();});


describe("durable exact coverage command recovery",()=>{
  it("recovers exact committed receipt after source cancellation and legitimate patient merge",async()=>{
    const f=await fixture(),c=await command(f),saved=await append(f,c),other=await fixture();
    await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.invoice]);
    await q("UPDATE ortho_cases SET status='completed' WHERE id=$1",[other.ortho]);
    await q("UPDATE ortho_cases SET patient_id=$2 WHERE id=$1",[f.ortho,other.patient]);
    const input={session:admin,patientId:f.patient,orthoCaseId:f.ortho,command:c};
    expect(await coverage.readFollowupCoverageCommandStatus(input)).toEqual({state:'committed',revision:saved.revision});
    expect((await coverage.appendFollowupCoverage(input)).replayed).toBe(true);
    await expect(coverage.readFollowupCoverageCommandStatus({...input,command:{...c,reason:'Different command'}})).rejects.toMatchObject({code:'command_conflict'});
  });
  it("persists terminal refusal and never upgrades its command after source repair",async()=>{
    const f=await fixture(),c=await command(f);
    await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.invoice]);
    await expect(append(f,c)).rejects.toMatchObject({code:'source_changed',rejection:{terminal:true,command:c,actor:admin.username}});
    await q("UPDATE invoices SET status='unpaid' WHERE id=$1",[f.invoice]);
    const input={session:admin,patientId:f.patient,orthoCaseId:f.ortho,command:c};
    expect(await coverage.readFollowupCoverageCommandStatus(input)).toMatchObject({state:'rejected',rejection:{commandId:c.commandId,patientId:f.patient,orthoCaseId:f.ortho,actor:admin.username,terminal:true,command:c}});
    await expect(append(f,c)).rejects.toMatchObject({code:'source_changed',rejection:{commandId:c.commandId}});
    expect(await q('SELECT id FROM ortho_followup_coverage_revisions WHERE command_id=$1',[c.commandId])).toEqual([]);
    for(const sql of ['DELETE FROM ortho_followup_coverage_rejections WHERE command_id=$1',"UPDATE ortho_followup_coverage_rejections SET code='case_closed' WHERE command_id=$1"])
      await expect(q(sql,[c.commandId])).rejects.toThrow('append-only');
    await expect(q('TRUNCATE ortho_followup_coverage_rejections')).rejects.toThrow('cannot be truncated');
    await expect(q(`INSERT INTO ortho_followup_coverage_rejections
      (command_id,request_fingerprint,patient_id,ortho_case_id,actor_user_id,actor,command,code,message)
      SELECT $2,request_fingerprint,patient_id,ortho_case_id,actor_user_id,actor,command,code,message
      FROM ortho_followup_coverage_rejections WHERE command_id=$1`,[c.commandId,randomUUID()])).rejects.toThrow('identity mismatch');
  });
  it("missing receipt stays unresolved and revoked credentials cannot read historical receipts",async()=>{
    const f=await fixture(),c=await command(f),input={session:admin,patientId:f.patient,orthoCaseId:f.ortho,command:c};
    expect(await coverage.readFollowupCoverageCommandStatus(input)).toEqual({state:'unresolved'});
    await append(f,c);
    await q("UPDATE users SET role='doctor' WHERE id=$1",[admin.userId]);
    try{await expect(coverage.readFollowupCoverageCommandStatus(input)).rejects.toMatchObject({status:403});}
    finally{await q("UPDATE users SET role='admin' WHERE id=$1",[admin.userId]);}
  });
  it("records closed/stale refusal only for a distinct exact command",async()=>{
    const f=await fixture(),c=await command(f);await append(f,c);
    await expect(q(`INSERT INTO ortho_followup_coverage_rejections
      (command_id,request_fingerprint,patient_id,ortho_case_id,actor_user_id,actor,command,code,message)
      SELECT command_id,request_fingerprint,patient_id,ortho_case_id,actor_user_id,created_by,$2::jsonb,'stale_coverage','Synthetic refused'
      FROM ortho_followup_coverage_revisions WHERE command_id=$1`,[c.commandId,JSON.stringify(c)])).rejects.toThrow('terminal outcome');
    const stale={...c,commandId:randomUUID()};
    await expect(append(f,stale)).rejects.toMatchObject({code:'stale_coverage',rejection:{command:stale}});
    await expect(append(f,{...c,reason:'Changed same key'})).rejects.toMatchObject({code:'command_conflict',rejection:undefined});
    const g=await fixture(),closed=await command(g);await q("UPDATE ortho_cases SET status='completed' WHERE id=$1",[g.ortho]);
    await expect(append(g,closed)).rejects.toMatchObject({code:'case_closed',rejection:{command:closed}});
  });
  it("rolls back tombstone if its mandatory audit fails",async()=>{
    const f=await fixture(),c=await command(f);await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.invoice]);
    await q(`CREATE FUNCTION synthetic_recovery_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.followup_coverage.append' THEN RAISE EXCEPTION 'synthetic refusal audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_recovery_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_recovery_audit_failure();`);
    try{await expect(append(f,c)).rejects.toThrow('synthetic refusal audit failure');}
    finally{await q('DROP TRIGGER synthetic_recovery_audit_failure ON audit_log; DROP FUNCTION synthetic_recovery_audit_failure();');}
    expect(await coverage.readFollowupCoverageCommandStatus({session:admin,patientId:f.patient,orthoCaseId:f.ortho,command:c})).toEqual({state:'unresolved'});
  });
});
