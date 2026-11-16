import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SessionPayload } from "../lib/auth";
import type { FollowupCoverageCommand } from "../lib/ortho-followup-coverage";
vi.stubEnv("USE_LOCAL_DB","true");vi.stubEnv("NODE_ENV","test");vi.stubEnv("RAILWAY_PROJECT_ID","");
vi.stubEnv("SESSION_SECRET","synthetic-followup-authority-test-only-0123456789");
const db=await import("../lib/db");
const {sessionCredentialVersion}=await import("../lib/auth");
const coverage=await import("../lib/ortho-followup-coverage-db");
const {walkoutNeedsReview,adjustmentLabel}=await import("../lib/walkout-presentation");
const {readVisitFinancialContext}=await import("../lib/visit-financial-context-db");
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
afterAll(async()=>{await db.resetPoolForTesting();});

describe("actual SQL explicit routine followup source decisions",()=>{
  it("keeps an ordinary invoice unknown until the exact scoped decision is recorded",async()=>{
    const f=await fixture();
    expect(await db.orthoAdjustmentBillingClass(db.getPool(),f.ortho,f.patient)).toBe("REVIEW_REQUIRED");
    const saved=await append(f,await command(f));
    expect(await db.orthoAdjustmentCoverage(db.getPool(),f.ortho,f.patient)).toEqual({classification:"INCLUDED",revisionId:saved.revision.id});
    expect((await q("SELECT count(*)::int AS n FROM plan_installments WHERE plan_id=$1",[f.plan]))[0].n).toBe(0);
    expect((await q("SELECT total_minor::text FROM invoices WHERE id=$1",[f.invoice]))[0].total_minor).toBe("250000");
    expect((await q("SELECT details FROM audit_log WHERE action='ortho.followup_coverage.append' AND entity_id=$1",[String(f.ortho)]))).toHaveLength(1);
  });
  it("CAS refuses stale editors, preserves unrelated history and reconciles only the exact command",async()=>{
    const f=await fixture(),a=await command(f),b={...a,commandId:randomUUID(),decision:"excluded" as const};
    const first=await append(f,a);expect((await append(f,a)).replayed).toBe(true);
    await expect(append(f,b)).rejects.toMatchObject({code:"stale_coverage"});
    await expect(append(f,{...a,decision:"excluded"})).rejects.toMatchObject({code:"command_conflict"});
    await append(f,await command(f,"excluded"));
    expect(await db.orthoAdjustmentBillingClass(db.getPool(),f.ortho,f.patient)).toBe("OUTSIDE_CONTRACT");
    expect((await q("SELECT decision FROM ortho_followup_coverage_revisions WHERE id=$1",[first.revision.id]))[0].decision).toBe("included");
  });
  it("does not use a different patient/case/item or a stale commercial source",async()=>{
    const f=await fixture(),other=await fixture(),c=await command(f);
    await expect(append(f,{...c,commandId:randomUUID(),source:{...c.source,planItemId:other.item}})).rejects.toMatchObject({code:"source_changed"});
    await q("UPDATE invoices SET discount_minor=100 WHERE id=$1",[f.invoice]);
    await expect(append(f,c)).rejects.toMatchObject({code:"source_changed"});
    const fresh=await command(f);await append(f,fresh);
    await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.invoice]);
    expect(await db.orthoAdjustmentBillingClass(db.getPool(),f.ortho,f.patient)).toBe("REVIEW_REQUIRED");
    expect((await coverage.readFollowupCoverage({session:admin,patientId:f.patient,orthoCaseId:f.ortho})).applicable).toBe(false);
  });
  it("rejects revoked credentials and non-administrators at the writer boundary",async()=>{
    const f=await fixture(),c=await command(f);
    await q("UPDATE users SET role='reception' WHERE id=$1",[admin.userId]);
    try{await expect(append(f,c)).rejects.toMatchObject({status:403});}finally{await q("UPDATE users SET role='admin' WHERE id=$1",[admin.userId]);}
    await expect(append(f,c,{...admin,credentialVersion:sessionCredentialVersion('other-synthetic-hash')})).rejects.toMatchObject({status:403});
    expect(await q("SELECT id FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1",[f.ortho])).toEqual([]);
  });
  it("rolls back the revision when the mandatory before/after audit fails",async()=>{
    const f=await fixture(),c=await command(f);
    await q(`CREATE FUNCTION synthetic_coverage_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.followup_coverage.append' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_coverage_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_coverage_audit_failure();`);
    try{await expect(append(f,c)).rejects.toThrow("synthetic audit failure");expect(await q("SELECT id FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1",[f.ortho])).toEqual([]);}
    finally{await q("DROP TRIGGER synthetic_coverage_audit_failure ON audit_log; DROP FUNCTION synthetic_coverage_audit_failure();");}
  });
  it("schema refuses rewrite, deletion and truncation of coverage history",async()=>{
    const f=await fixture(),saved=await append(f,await command(f));
    for(const sql of ["UPDATE ortho_followup_coverage_revisions SET decision='excluded' WHERE id=$1","DELETE FROM ortho_followup_coverage_revisions WHERE id=$1"])
      await expect(q(sql,[saved.revision.id])).rejects.toThrow("append-only");
    await expect(q("TRUNCATE ortho_followup_coverage_revisions CASCADE")).rejects.toThrow("append-only");
  });
  it("signed proof remains historical across a later exclusion, but invalidated source becomes review",async()=>{
    const f=await fixture(),saved=await append(f,await command(f));
    const visit=(await q("INSERT INTO visits(patient_name,patient_id,doctor_id,chief_complaint,diagnosis) VALUES('Synthetic coverage patient',$1,$2,'Routine followup','Synthetic diagnosis') RETURNING id",[f.patient,provider]))[0].id;
    const adjustment=(await q("INSERT INTO ortho_adjustments(case_id,visit_id,done_on,recorded_by,billing_class,followup_coverage_revision_id) VALUES($1,$2,CURRENT_DATE,'synthetic-admin','INCLUDED',$3) RETURNING id",[f.ortho,visit,saved.revision.id]))[0].id;
    await q("UPDATE visits SET signed_at=NOW(),signed_by='synthetic-admin',ortho_followup_coverage_proof=$2::jsonb WHERE id=$1",[visit,JSON.stringify([{adjustmentId:adjustment,caseId:f.ortho,revisionId:saved.revision.id,patientId:f.patient}])]);
    await append(f,await command(f,"excluded"));
    expect((await coverage.readSignedFollowupProofs(db.getPool(),[adjustment])).get(adjustment)).toEqual({invoiceId:f.invoice,valid:true});
    const otherVisit=(await q("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic second visit',$1) RETURNING id",[f.patient]))[0].id;
    await expect(q("UPDATE ortho_adjustments SET visit_id=$1 WHERE visit_id=$2",[otherVisit,visit])).rejects.toThrow("Signed coverage proof cannot be rewritten");
    const context=await readVisitFinancialContext(db.getPool(),visit,f.patient);
    expect(context?.summary).toBe("verified");
    expect(context?.work.find(w=>w.kind==='orthodontic_adjustment')?.references).toContainEqual({kind:'invoice',id:f.invoice,state:'current',path:'routine_followup_coverage'});
    await expect(q("UPDATE ortho_adjustments SET followup_coverage_revision_id=NULL WHERE id=$1",[adjustment])).rejects.toThrow("cannot be rewritten");
    const old=(await q("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by) VALUES($1,CURRENT_DATE,'synthetic-admin') RETURNING id",[f.ortho]))[0].id;
    await expect(q("UPDATE ortho_adjustments SET visit_id=$2,followup_coverage_revision_id=$3 WHERE id=$1",[old,visit,saved.revision.id])).rejects.toThrow();
    await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.invoice]);
    expect((await readVisitFinancialContext(db.getPool(),visit,f.patient))?.summary).toBe("unresolved");
    const invalidated=await db.visitWalkout(visit);
    expect(invalidated?.orthoAdjustment).toMatchObject({billingClass:"INCLUDED",coverageReviewRequired:true,pendingDecision:false});
    expect(walkoutNeedsReview(invalidated!)).toBe(true);
    expect(adjustmentLabel(invalidated!.orthoAdjustment!)).toContain("تغيّر مصدر");
    expect((await q("SELECT billing_class,followup_coverage_revision_id::text FROM ortho_adjustments WHERE id=$1",[adjustment]))[0]).toEqual({billing_class:'INCLUDED',followup_coverage_revision_id:saved.revision.id});
  });
  it("actual signing freezes included coverage, creates no adjustment invoice, and preserves an independently billed extra",async()=>{
    const f=await fixture(),saved=await append(f,await command(f));
    const makeVisit=async()=> (await q("INSERT INTO visits(patient_name,patient_id,doctor_id,chief_complaint,diagnosis) VALUES('Synthetic coverage patient',$1,$2,'Routine followup','Synthetic diagnosis') RETURNING id",[f.patient,provider]))[0].id as number;
    const session={caseId:f.ortho,phase:null,upperWire:null,lowerWire:null,elastics:'none' as const,elasticNote:null,done:'Synthetic routine adjustment',nextWeeks:4,note:null};
    const visit=await makeVisit();
    const before=(await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[f.patient]))[0].n;
    const signed=await db.signClinicalVisit({visitId:visit,baseCurrency:'YER',signedBy:admin.username,signerRole:'admin',signerDoctorPartyId:provider,orthoSession:session});
    expect(signed.reason).toBeNull();expect(signed.orthoBillingClass).toBe('INCLUDED');expect(signed.invoiceId).toBeNull();
    expect((await q("SELECT followup_coverage_revision_id::text FROM ortho_adjustments WHERE visit_id=$1",[visit]))[0].followup_coverage_revision_id).toBe(saved.revision.id);
    expect((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[f.patient]))[0].n).toBe(before);
    expect((await readVisitFinancialContext(db.getPool(),visit,f.patient))?.summary).toBe('verified');
    const walkout=await db.visitWalkout(visit);expect(walkout?.orthoAdjustment).toMatchObject({billingClass:'INCLUDED',pendingDecision:false});
    const extra=(await q("INSERT INTO services(name,category,price_minor) VALUES('Synthetic separate consultation','consultation',12500) RETURNING id"))[0].id;
    const second=await makeVisit();
    await q("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,quantity,unit_price_minor) VALUES($1,$2,$3,1,12500)",[second,extra,provider]);
    const withExtra=await db.signClinicalVisit({visitId:second,baseCurrency:'YER',signedBy:admin.username,signerRole:'admin',signerDoctorPartyId:provider,orthoSession:session});
    expect(withExtra.reason).toBeNull();expect(withExtra.orthoBillingClass).toBe('INCLUDED');expect(withExtra.invoiceId).not.toBeNull();expect(withExtra.duesMinor).toBe(12500);
  });

  it.each([false,true])("does not leak the first explicit case proof across multiple adjustment rows (same case: %s)",async(sameCase)=>{
    const f=await fixture();await append(f,await command(f));
    const secondCase=sameCase?f.ortho:(await q("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic-admin','completed') RETURNING id",[f.patient]))[0].id;
    const visit=(await q("INSERT INTO visits(patient_name,patient_id,doctor_id,diagnosis) VALUES('Synthetic coverage patient',$1,$2,'Synthetic review') RETURNING id",[f.patient,provider]))[0].id;
    for(const caseId of [f.ortho,secondCase]) await q("INSERT INTO ortho_adjustments(case_id,visit_id,done_on,recorded_by,done) VALUES($1,$2,CURRENT_DATE,'synthetic-admin','Synthetic documented review')",[caseId,visit]);
    const before=(await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[f.patient]))[0].n;
    const result=await db.signClinicalVisit({visitId:visit,baseCurrency:'YER',signedBy:admin.username,signerRole:'admin',signerDoctorPartyId:provider});
    expect(result.reason).toBe('ortho_adjustments_ambiguous');
    expect((await q("SELECT signed_at,ortho_followup_coverage_proof FROM visits WHERE id=$1",[visit]))[0]).toEqual({signed_at:null,ortho_followup_coverage_proof:null});
    expect(await q("SELECT id FROM ortho_adjustments WHERE visit_id=$1 AND followup_coverage_revision_id IS NOT NULL",[visit])).toEqual([]);
    expect((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[f.patient]))[0].n).toBe(before);
  });

  it("payment and clinical progress do not silently revoke fixed commercial coverage",async()=>{
    const f=await fixture();await append(f,await command(f));
    await q("UPDATE invoices SET status='paid' WHERE id=$1",[f.invoice]);
    await q("UPDATE plan_items SET status='done' WHERE id=$1",[f.item]);
    expect(await db.orthoAdjustmentBillingClass(db.getPool(),f.ortho,f.patient)).toBe('INCLUDED');
  });
  it("a second live invoice identity cannot be selected as ambiguous routine coverage",async()=>{
    const f=await fixture(),c=await command(f);
    const duplicate=(await q("INSERT INTO invoices(patient_id,invoice_number,total_minor) VALUES($1,$2,250000) RETURNING id",[f.patient,`SYN-DUP-${f.patient}`]))[0].id;
    await q("INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,plan_item_id) VALUES($1,$2,$3,'Synthetic duplicate',1,250000,250000,$4)",[duplicate,service,provider,f.item]);
    expect((await coverage.readFollowupCoverage({session:admin,patientId:f.patient,orthoCaseId:f.ortho})).sources).toEqual([]);
    await expect(append(f,c)).rejects.toMatchObject({code:'source_changed'});
  });
  it("missing registered schema disables new decisions instead of implicitly migrating or granting coverage",async()=>{
    const f=await fixture(),c=await command(f);
    await q("ALTER TABLE ortho_followup_coverage_revisions RENAME TO synthetic_temporarily_unavailable_coverage");
    try{
      expect(await coverage.followupCoverageAvailable(db.getPool())).toBe(false);
      await expect(append(f,c)).rejects.toMatchObject({status:503,code:'coverage_not_ready'});
      expect(await db.orthoAdjustmentBillingClass(db.getPool(),f.ortho,f.patient)).toBe('REVIEW_REQUIRED');
    }finally{await q("ALTER TABLE synthetic_temporarily_unavailable_coverage RENAME TO ortho_followup_coverage_revisions");}
  });

});
