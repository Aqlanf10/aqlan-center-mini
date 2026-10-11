import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { visibleEndoTreatment } from "../../lib/endodontics-response";
import { checkEndoVisitDraft } from "../../lib/endodontics";
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const endo = await import("../../lib/endodontics-db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
const actor = { actor: "synthetic", actorRole: "doctor" };
let seq = 0; let d1: number; let d2: number; let supplier: number; let rctService: number; let crownService: number;
const draft = (body: Record<string, unknown>) => { const c = checkEndoVisitDraft(body); if (!c.ok) throw new Error(c.message); return c.value; };
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema();
  [d1, d2, supplier] = await Promise.all(["doctor", "doctor", "supplier"].map(async (kind) =>
    (await q("INSERT INTO parties(kind,name) VALUES($1,'synthetic') RETURNING id", [kind]))[0].id));
  rctService = (await q("INSERT INTO services(name,category,price_minor) VALUES('RCT','rct',1) RETURNING id"))[0].id;
  crownService = (await q("INSERT INTO services(name,category,price_minor) VALUES('crown','crown',1) RETURNING id"))[0].id;
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture() {
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'synthetic') RETURNING id", [`ENDO-I-${++seq}`]))[0].id;
  const caseId = (await q("INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by) VALUES($1,'endodontics','synthetic','36','a') RETURNING id", [patientId]))[0].id;
  const opened = await endo.openEndoTreatment({ ...actor, patientId, caseId, toothCode: 36, kind: "initial" });
  if (!opened.ok) throw new Error(opened.reason);
  const treatmentId = opened.treatment.id;
  const visitId = (await q("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'synthetic',$2) RETURNING id", [patientId,d1]))[0].id;
  const planId = (await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status) VALUES($1,'synthetic',2,'active') RETURNING id", [patientId]))[0].id;
  const item = async (category: string, tooth=36, linkedCase: number|null=caseId) =>
    (await q("INSERT INTO plan_items(plan_id,service_name,category,tooth_code,case_id,unit_price_minor) VALUES($1,$2,$2,$3,$4,1) RETURNING id", [planId,category,tooth,linkedCase]))[0].id as number;
  const rct = await item("rct"); const crown = await item("crown");
  const save = (body: Record<string, unknown>, expectedVersion: number|null=null, actorPartyId: number|null=d2) =>
    endo.saveEndoVisit({ ...actor, patientId, treatmentId, visitId, draft: draft(body), expectedVersion, actorPartyId });
  const decide = (overrides: Partial<Parameters<typeof endo.setEndoCrown>[0]>={}) =>
    endo.setEndoCrown({ ...actor, patientId, treatmentId, crownRequired: true, crownPlanItemId:crown, rctPlanItemId:rct, ...overrides });
  const procedure = (doctor: number, tooth=36, service=rctService, planItem: number|null=rct) =>
    q("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,plan_item_id,unit_price_minor) VALUES($1,$2,$3,$4,$5,1)", [visitId,service,doctor,tooth,planItem]);
  return {patientId,caseId,treatmentId,visitId,planId,rct,crown,item,save,decide,procedure};
}
async function snapshot(treatmentId: number) {
  return { treatment:(await q("SELECT * FROM endo_treatments WHERE id=$1",[treatmentId]))[0],
    audit: await q("SELECT id, action FROM audit_log WHERE action IN ('endo.crown','plan.dependency_add') ORDER BY id") };
}
describe("Endodontics integrity regressions", () => {
  it("preserves the relevant procedure doctor over visit/signer and retains attribution on edits", async () => {
    const f=await fixture(); await f.procedure(d2); await f.procedure(d1,46); await f.procedure(d1,36,crownService,null);
    expect(await f.save({note:"initial"})).toMatchObject({ok:true});
    expect((await q("SELECT doctor_id FROM endo_visits WHERE visit_id=$1",[f.visitId]))[0].doctor_id).toBe(d2);
    await q("UPDATE visits SET doctor_id=$2 WHERE id=$1",[f.visitId,d1]);
    expect(await f.save({note:"edited"},1,d1)).toMatchObject({ok:true});
    expect((await q("SELECT doctor_id FROM endo_visits WHERE visit_id=$1",[f.visitId]))[0].doctor_id).toBe(d2);
    expect((await q("SELECT doctor_id FROM visit_procedures WHERE visit_id=$1 AND plan_item_id=$2",[f.visitId,f.rct]))[0].doctor_id).toBe(d2);
  });
  it("ignores another case's procedure and refuses ambiguous or invalid explicit providers", async () => {
    const f=await fixture();
    const otherCase=(await q("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'endodontics','other','a') RETURNING id",[f.patientId]))[0].id;
    await f.procedure(d2,36,rctService,await f.item("rct",36,otherCase));
    expect(await f.save({note:"own case"})).toMatchObject({ok:true});
    expect((await q("SELECT doctor_id FROM endo_visits WHERE visit_id=$1",[f.visitId]))[0].doctor_id).toBe(d1);
    const ambiguous=await fixture(); await ambiguous.procedure(d1); await ambiguous.procedure(d2);
    expect(await ambiguous.save({note:"ambiguous"})).toEqual({ok:false,reason:"ambiguous_doctor"});
    const bad=await fixture(); await bad.procedure(supplier);
    expect(await bad.save({note:"invalid explicit"})).toEqual({ok:false,reason:"no_treating_doctor"});
    const admin=await fixture(); await q("UPDATE visits SET doctor_id=NULL WHERE id=$1",[admin.visitId]);
    expect(await admin.save({note:"admin with supplier party"},null,supplier)).toEqual({ok:false,reason:"no_treating_doctor"});
  });
  it("lost update-response retries do not change version, timestamps, canals or audit", async () => {
    const f=await fixture(); await f.save({note:"first"});
    const body={note:"changed",canals:[{label:"MB",workingLengthMm:20,referencePoint:"cusp_tip",measurementMethod:"both"}]};
    expect(await f.save(body,1)).toMatchObject({ok:true,unchanged:false});
    const before=await q("SELECT * FROM endo_visits WHERE visit_id=$1",[f.visitId]);
    const canals=await q("SELECT * FROM endo_canal_records WHERE endo_visit_id=$1",[before[0].id]);
    const audits=await q("SELECT id FROM audit_log WHERE action='endo.visit_save'");
    const retries=await Promise.all(Array.from({length:5},()=>f.save(body,1)));
    expect(retries.every(result=>result.ok&&result.unchanged)).toBe(true);
    expect(await q("SELECT * FROM endo_visits WHERE visit_id=$1",[f.visitId])).toEqual(before);
    expect(await q("SELECT * FROM endo_canal_records WHERE endo_visit_id=$1",[before[0].id])).toEqual(canals);
    expect(await q("SELECT id FROM audit_log WHERE action='endo.visit_save'")).toEqual(audits);
    expect(await f.save({...body,note:"different stale"},1)).toEqual({ok:false,reason:"version_conflict"});
  });
  it("correcting an unsigned restoration clears the cached permanent state", async () => {
    const f=await fixture(); await f.save({note:"incorrect",restorationAfter:"permanent"});
    const result=await f.save({note:"corrected",restorationAfter:null},1);
    expect(result).toMatchObject({ok:true,treatment:{restorativeStatus:"none"}});
  });
  it("rejects self/missing/foreign/cross-tooth/wrong-category/wrong-case crown inputs without changes", async () => {
    const f=await fixture(); const other=await fixture(); const before=await snapshot(f.treatmentId);
    for(const overrides of [
      {rctPlanItemId:null},{rctPlanItemId:f.crown},{rctPlanItemId:999999}, {rctPlanItemId:other.rct},
      {rctPlanItemId:await f.item("rct",46)}, {rctPlanItemId:await f.item("filling")},
      {rctPlanItemId:await f.item("rct",36,null)},
    ]) expect(await f.decide(overrides)).toEqual({ok:false,reason:"bad_rct"});
    expect(await f.decide({crownPlanItemId:await f.item("filling")})).toEqual({ok:false,reason:"bad_item"});
    expect(await snapshot(f.treatmentId)).toEqual(before);
  });
  it("cycle and incompatible existing edge refuse atomically; normal standalone helper still works", async () => {
    const f=await fixture();
    expect(await db.addPlanItemDependency({...actor,itemId:f.rct,requiresItemId:f.crown,requirement:"completed",note:null})).toEqual({ok:true});
    const before=await snapshot(f.treatmentId);
    expect(await f.decide()).toEqual({ok:false,reason:"dependency_conflict"});
    expect(await snapshot(f.treatmentId)).toEqual(before);
    const g=await fixture();
    await db.addPlanItemDependency({...actor,itemId:g.crown,requiresItemId:g.rct,requirement:"clearance",note:null});
    const beforeG=await snapshot(g.treatmentId);
    expect(await g.decide()).toEqual({ok:false,reason:"dependency_conflict"});
    expect(await snapshot(g.treatmentId)).toEqual(beforeG);
  });
  it("crown retry is a no-op and failures after dependency insertion roll back the edge and all audits", async () => {
    const f=await fixture(); expect(await f.decide()).toMatchObject({ok:true}); const before=await snapshot(f.treatmentId);
    expect(await f.decide()).toMatchObject({ok:true}); expect(await snapshot(f.treatmentId)).toEqual(before);
    const g=await fixture(); const previous=await snapshot(g.treatmentId);
    await q(`CREATE FUNCTION synthetic_refuse_endo_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='endo.crown' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_refuse_endo_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_refuse_endo_audit()`);
    try { await expect(g.decide()).rejects.toThrow("synthetic"); } finally { await q("DROP TRIGGER synthetic_refuse_endo_audit ON audit_log; DROP FUNCTION synthetic_refuse_endo_audit()"); }
    expect(await snapshot(g.treatmentId)).toEqual(previous);
    expect(await q("SELECT * FROM plan_item_dependencies WHERE item_id=$1",[g.crown])).toEqual([]);
  });
  it("the composed helper leaves the caller's transaction open and respects caller rollback", async () => {
    const f=await fixture(); const client=await db.getPool().connect();
    try { await client.query("BEGIN");
      expect(await db.addPlanItemDependencyInTransaction(client,{...actor,itemId:f.crown,requiresItemId:f.rct,requirement:"completed",note:null})).toEqual({ok:true});
      expect((await client.query("SELECT 1 FROM plan_item_dependencies WHERE item_id=$1",[f.crown])).rows).toHaveLength(1);
      await client.query("ROLLBACK");
    } finally {client.release();}
    expect(await q("SELECT * FROM plan_item_dependencies WHERE item_id=$1",[f.crown])).toEqual([]);
  });
  it("addendum concurrency and lost responses append/audit once; key binds author and content", async () => {
    const f=await fixture(); await f.save({note:"signed clinical work"});
    await q("UPDATE visits SET signed_at=NOW(),signed_by='synthetic' WHERE id=$1",[f.visitId]);
    const endoVisitId=(await q("SELECT id FROM endo_visits WHERE visit_id=$1",[f.visitId]))[0].id;
    const input={...actor,patientId:f.patientId,treatmentId:f.treatmentId,endoVisitId,text:"correction",requestKey:"endo:concurrent-addendum"};
    const results=await Promise.all(Array.from({length:5},()=>endo.addEndoAddendum(input)));
    expect(results.every((result)=>result.ok)).toBe(true);
    expect(results.filter((result)=>result.ok&&result.created)).toHaveLength(1);
    const rows=await q("SELECT * FROM endo_addenda WHERE endo_visit_id=$1",[endoVisitId]);
    expect(rows).toHaveLength(1);
    const audits=await q("SELECT * FROM audit_log WHERE action='endo.addendum'");
    expect(await endo.addEndoAddendum({...input,text:"  correction  "})).toMatchObject({ok:true,created:false});
    expect(await endo.addEndoAddendum({...input,text:"  "})).toEqual({ok:false,reason:"bad_text"});
    expect(await endo.addEndoAddendum({...input,text:"different"})).toEqual({ok:false,reason:"idempotency_conflict"});
    expect(await endo.addEndoAddendum({...input,actor:"different"})).toEqual({ok:false,reason:"idempotency_conflict"});
    expect(await endo.addEndoAddendum({...input,requestKey:"bad"})).toEqual({ok:false,reason:"bad_key"});
    expect(await q("SELECT * FROM endo_addenda WHERE endo_visit_id=$1",[endoVisitId])).toEqual(rows);
    expect(await q("SELECT * FROM audit_log WHERE action='endo.addendum'")).toEqual(audits);
    expect(await endo.addEndoAddendum({...input,requestKey:"endo:another-logical-addendum"})).toMatchObject({ok:true,created:true});
  });
  it("a doctor without plan edit rights cannot unlink an existing crown using null IDs", async () => {
    const f=await fixture(); await f.decide(); const before=await snapshot(f.treatmentId);
    expect(await f.decide({crownRequired:false,crownPlanItemId:null,rctPlanItemId:null,canEditPlanLinks:false}))
      .toEqual({ok:false,reason:"plan_forbidden"});
    expect(await snapshot(f.treatmentId)).toEqual(before);
  });

  it("maps persisted records for sign-off without treating empty stage/canal-label drafts as work", async () => {
    const f=await fixture();
    expect(await endo.hasMeaningfulEndoVisit(db.getPool(),f.visitId)).toBe(false);
    await f.save({stage:"shaping",canals:[{label:"MB"}]});
    expect(await endo.hasMeaningfulEndoVisit(db.getPool(),f.visitId)).toBe(false);
    await f.save({note:"actual clinical record"},1);
    expect(await endo.hasMeaningfulEndoVisit(db.getPool(),f.visitId)).toBe(true);
  });

  it("a permanent core preserves crown follow-up until its actual plan item is done", async () => {
    const f=await fixture();
    const saved=await f.save({stage:"obturation",canalsFound:1,restorationAfter:"permanent",
      canals:[{label:"MB",workingLengthMm:20,referencePoint:"cusp_tip",measurementMethod:"both",obturated:true}]});
    expect(saved).toMatchObject({ok:true,treatment:{restorativeStatus:"permanent",crown:"undecided"}});
    expect(await f.decide()).toMatchObject({ok:true,treatment:{restorativeStatus:"permanent",crown:"waiting_rct"}});
    await q("UPDATE visits SET signed_at=NOW(),signed_by='synthetic' WHERE id=$1",[f.visitId]);
    const completed=await endo.changeEndoStatus({...actor,patientId:f.patientId,treatmentId:f.treatmentId,status:"completed",outcome:null});
    expect(completed).toMatchObject({ok:true,treatment:{restorativeStatus:"permanent",crown:"ready",nextAction:"إحالة السن للتاج."}});
    let view=(await endo.listPatientEndo(f.patientId))[0];
    expect(visibleEndoTreatment(view,false)).toMatchObject({restorativeStatus:"permanent",crown:"ready",crownPlanItem:null,nextAction:"إحالة السن للتاج."});
    await q("UPDATE plan_items SET status='done' WHERE id=$1",[f.crown]);
    view=(await endo.listPatientEndo(f.patientId))[0];
    expect(view).toMatchObject({restorativeStatus:"permanent",crown:"planned_done",crownPlanItem:{id:f.crown,status:"done"}});
    expect(await f.decide({crownRequired:false,crownPlanItemId:null,rctPlanItemId:null}))
      .toMatchObject({ok:true,treatment:{restorativeStatus:"permanent",crown:"not_required"}});
    // Persisted completed episodes with no decision still ask for that decision.
    await q("UPDATE endo_treatments SET crown_required=NULL WHERE id=$1",[f.treatmentId]);
    view=(await endo.listPatientEndo(f.patientId))[0];
    expect(view).toMatchObject({restorativeStatus:"permanent",crown:"undecided",nextAction:"قرّر الحاجة إلى تاج."});
  });

});
