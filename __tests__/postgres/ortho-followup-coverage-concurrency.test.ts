import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {assertRealPostgresUrl,stubPostgresEnv,adminClient} from "./_setup";
import type {SessionPayload} from "../../lib/auth";
import type {FollowupCoverageCommand} from "../../lib/ortho-followup-coverage";
assertRealPostgresUrl();stubPostgresEnv();
const databaseName=`aqlan_ortho_followup_${process.pid}_${Date.now().toString(36)}`;
if(!/^aqlan_ortho_followup_[a-z0-9_]+$/.test(databaseName))throw new Error("Unsafe synthetic database name");
const maintenance=adminClient("postgres");await maintenance.connect();
try{await maintenance.query(`CREATE DATABASE "${databaseName}"`);}finally{await maintenance.end();}
const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname=`/${databaseName}`;process.env.DATABASE_URL=url.toString();
console.log(`Owned synthetic coverage database: ${databaseName}; no prior database dropped`);
const db=await import("../../lib/db");
const {sessionCredentialVersion}=await import("../../lib/auth");
const coverage=await import("../../lib/ortho-followup-coverage-db");
const raw=new Pool({connectionString:url.toString(),ssl:false,max:4});
const q=async(sql:string,args:unknown[]=[]) => (await db.getPool().query(sql,args)).rows;
let admin:SessionPayload,provider:number,service:number;
let seq=0;
async function fixture(){
  const n=++seq;
  const patient=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic coverage patient') RETURNING id",[`SYN-COV-${n}`]))[0].id;
  const ortho=(await q("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic-admin') RETURNING id",[patient]))[0].id;
  const clinical=(await q("INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic ortho','both',$2,'synthetic-admin') RETURNING id",[patient,ortho]))[0].id;
  const plan=(await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,consent_at,consent_by) VALUES($1,'Synthetic invoice-origin agreement',250000,'YER',NOW(),'synthetic-admin') RETURNING id",[patient]))[0].id;
  const invoice=(await q("INSERT INTO invoices(patient_id,invoice_number,total_minor,base_currency) VALUES($1,$2,250000,'YER') RETURNING id",[patient,`SYN-COV-INV-${n}`]))[0].id;
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
  const user=(await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-coverage-admin','Synthetic admin','synthetic-hash','admin') RETURNING id"))[0];
  admin={userId:user.id,username:"synthetic-coverage-admin",role:"admin",expiresAt:Date.now()+300_000,credentialVersion:sessionCredentialVersion("synthetic-hash")};
  provider=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic treating provider','doctor') RETURNING id"))[0].id;
  service=(await q("INSERT INTO services(name,category,price_minor) VALUES('Synthetic ortho treatment','ortho',250000) RETURNING id"))[0].id;
},90_000);
afterAll(async()=>{await db.resetPoolForTesting();await raw.end();});

function barrier(){let release!:()=>void;const promise=new Promise<void>(done=>{release=done;});return {promise,release};}
async function pausedAudit(caseId:number){
  const entered=barrier(),resume=barrier(),original=db.insertAuditRow;
  const spy=vi.spyOn(db,"insertAuditRow").mockImplementation(async(client,input)=>{
    if(input.action==='ortho.followup_coverage.append'&&input.entityId===caseId){entered.release();await resume.promise;}
    return original(client,input);
  });
  return {entered:entered.promise,release:resume.release,restore:()=>spy.mockRestore()};
}
async function waitBlocked(pid:number){
  const until=Date.now()+5000;
  while(Date.now()<until){if((await raw.query("SELECT cardinality(pg_blocking_pids($1)) AS n",[pid])).rows[0].n>0)return;await new Promise(done=>setTimeout(done,20));}
  throw new Error("Expected real PostgreSQL blocking was not observed");
}
async function waitForSigningPatientLock(){
  const until=Date.now()+5000;
  while(Date.now()<until){
    const {rows:[row]}=await raw.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1) AS blocked",['SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE%']);
    if(row.blocked)return;await new Promise(done=>setTimeout(done,20));
  }
  throw new Error("Signing did not reach its real patient lock behind the coverage writer");
}
describe('real PostgreSQL coverage transaction fences' ,()=>{
  it('serializes competing case decisions and refuses the old editor after the first commit',async()=>{
    const f=await fixture(),a=await command(f),b={...a,commandId:randomUUID(),decision:'excluded' as const};
    const paused=await pausedAudit(f.ortho);const first=append(f,a);
    try{await paused.entered;await expect(append(f,b)).rejects.toMatchObject({code:'55P03'});}
    finally{paused.release();}
    const saved=await first;paused.restore();
    await expect(append(f,b)).rejects.toMatchObject({code:'stale_coverage'});
    expect(await q("SELECT id::text FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1",[f.ortho])).toEqual([{id:saved.revision.id}]);
  });
  it('holds real account authority through the atomic audit and refuses a request after revocation commits',async()=>{
    const f=await fixture(),c=await command(f),paused=await pausedAudit(f.ortho),revoker=await raw.connect();
    const pid=(await revoker.query('SELECT pg_backend_pid() AS id')).rows[0].id;
    const writing=append(f,c);let revocation:Promise<unknown>|undefined;
    try{
      await paused.entered;
      revocation=revoker.query("UPDATE users SET role='reception' WHERE id=$1",[admin.userId]);
      await waitBlocked(pid);paused.release();const saved=await writing;await revocation;
      await expect(append(f,{...c,commandId:randomUUID(),expectedRevisionId:saved.revision.id,decision:'excluded'})).rejects.toMatchObject({status:403});
    }finally{paused.release();await writing.catch(()=>{});await revocation?.catch(()=>{});paused.restore();revoker.release();await q("UPDATE users SET role='admin' WHERE id=$1",[admin.userId]);}
  });
  it('cannot approve against an invoice being cancelled and rechecks its current source after commit',async()=>{
    const f=await fixture(),c=await command(f),cancel=await raw.connect();
    try{
      await cancel.query('BEGIN');await cancel.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.invoice]);
      await expect(append(f,c)).rejects.toMatchObject({code:'55P03'});
      await cancel.query('COMMIT');await expect(append(f,c)).rejects.toMatchObject({code:'source_changed'});
      expect(await q("SELECT id FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1",[f.ortho])).toEqual([]);
    }finally{await cancel.query('ROLLBACK');cancel.release();}
  });
  it('refuses signing while its included invoice source is being cancelled, then rechecks without adding debt',async()=>{
    const f=await fixture();await append(f,await command(f));
    const visit=(await q("INSERT INTO visits(patient_name,patient_id,doctor_id,chief_complaint,diagnosis) VALUES('Synthetic coverage patient',$1,$2,'Routine followup','Synthetic diagnosis') RETURNING id",[f.patient,provider]))[0].id;
    expect((await db.getClinicalVisit(visit))?.ortho?.adjustmentBillingClass).toBe('INCLUDED');
    const sign=()=>db.signClinicalVisit({visitId:visit,baseCurrency:'YER',signedBy:admin.username,signerRole:'admin',signerDoctorPartyId:provider,
      orthoSession:{caseId:f.ortho,phase:null,upperWire:null,lowerWire:null,elastics:'none',elasticNote:null,done:'Synthetic adjustment during source cancellation',nextWeeks:4,note:null}});
    const invoicesBefore=await q("SELECT id,total_minor::text FROM invoices WHERE patient_id=$1 ORDER BY id",[f.patient]);
    const cancel=await raw.connect();
    try{
      // The UPDATE has completed and owns the actual row lock before sign starts.
      // NOWAIT refusal is direct PostgreSQL evidence, not an elapsed-time guess.
      await cancel.query('BEGIN');
      await cancel.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.invoice]);
      await expect(sign()).rejects.toMatchObject({code:'55P03'});
      expect((await q("SELECT signed_at,invoice_id,ortho_followup_coverage_proof FROM visits WHERE id=$1",[visit]))[0])
        .toEqual({signed_at:null,invoice_id:null,ortho_followup_coverage_proof:null});
      expect(await q("SELECT id FROM ortho_adjustments WHERE visit_id=$1",[visit])).toEqual([]);
      expect(await q("SELECT id,total_minor::text FROM invoices WHERE patient_id=$1 ORDER BY id",[f.patient])).toEqual(invoicesBefore);
      await cancel.query('COMMIT');
      const retry=await sign();
      expect(retry.reason).toBeNull();expect(retry.orthoBillingClass).toBe('REVIEW_REQUIRED');expect(retry.invoiceId).toBeNull();
      expect((await q("SELECT billing_class,followup_coverage_revision_id FROM ortho_adjustments WHERE visit_id=$1",[visit]))[0])
        .toEqual({billing_class:'REVIEW_REQUIRED',followup_coverage_revision_id:null});
      expect((await q("SELECT ortho_followup_coverage_proof FROM visits WHERE id=$1",[visit]))[0].ortho_followup_coverage_proof).toBeNull();
      expect(await q("SELECT id,total_minor::text FROM invoices WHERE patient_id=$1 ORDER BY id",[f.patient])).toEqual(invoicesBefore);
      expect((await db.visitWalkout(visit))?.orthoAdjustment).toMatchObject({billingClass:'REVIEW_REQUIRED',pendingDecision:true});
    }finally{await cancel.query('ROLLBACK');cancel.release();}
  });
  it('signing reads the decision committed ahead of its patient lock, not its earlier preview',async()=>{
    const f=await fixture();await append(f,await command(f));
    const visit=(await q("INSERT INTO visits(patient_name,patient_id,doctor_id,chief_complaint,diagnosis) VALUES('Synthetic coverage patient',$1,$2,'Routine followup','Synthetic diagnosis') RETURNING id",[f.patient,provider]))[0].id;
    expect((await db.getClinicalVisit(visit))?.ortho?.adjustmentBillingClass).toBe('INCLUDED');
    const excluded=await command(f,'excluded'),paused=await pausedAudit(f.ortho),writing=append(f,excluded);
    let signing:ReturnType<typeof db.signClinicalVisit>|undefined;
    try{
      await paused.entered;
      signing=db.signClinicalVisit({visitId:visit,baseCurrency:'YER',signedBy:admin.username,signerRole:'admin',signerDoctorPartyId:provider,
        orthoSession:{caseId:f.ortho,phase:null,upperWire:null,lowerWire:null,elastics:'none',elasticNote:null,done:'Synthetic adjustment',nextWeeks:4,note:null}});
      await waitForSigningPatientLock();paused.release();await writing;const signed=await signing;
      expect(signed.reason).toBeNull();expect(signed.orthoBillingClass).toBe('OUTSIDE_CONTRACT');expect(signed.invoiceId).toBeNull();
      expect((await q("SELECT followup_coverage_revision_id FROM ortho_adjustments WHERE visit_id=$1",[visit]))[0].followup_coverage_revision_id).toBeNull();
    }finally{paused.release();await writing.catch(()=>{});await signing?.catch(()=>{});paused.restore();}
  });
});
