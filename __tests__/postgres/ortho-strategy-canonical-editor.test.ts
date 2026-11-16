import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalStrategy } from "../fixtures/canonical-ortho-strategy";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-strategy-write-secret-0123456789");
const db = await import("../../lib/db");
const store = await import("../../lib/ortho-treatment-strategy-store");
const reads = await import("../../lib/canonical-ortho-strategy");
const EDIT = { "clinical.ortho.view": true, "clinical.ortho.edit": true };
const PLANS = { ...EDIT, "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
  owner: { username: "SYN-OSW-OWNER", role: "admin" },
  own: { username: "SYN-OSW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-OSW-ALL", role: "reception", patientScope: "all", grants: EDIT },
  planView: { username: "SYN-OSW-PLANVIEW", role: "reception", patientScope: "all", grants: { ...EDIT, "clinical.plans.view": true } },
  planEdit: { username: "SYN-OSW-PLANEDIT", role: "reception", patientScope: "all", grants: PLANS },
  none: { username: "SYN-OSW-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-OSW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  read: { username: "SYN-OSW-READ", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true, status = "active", bridge = true) {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-OSW-${++seq}`, own ? fx.parties.own : null])).rows[0].id as number;
  const caseId = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,$2,'SYN') RETURNING id", [patientId, status])).rows[0].id as number;
  const bridgeId = bridge ? (await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN explicit bridge',$2,'SYN') RETURNING id", [patientId, caseId])).rows[0].id as number : 0;
  const problemId = bridge ? (await fx.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'SYN original problem','SYN') RETURNING id", [patientId, bridgeId])).rows[0].id as number : 0;
  return { patientId, caseId, bridgeId, problemId, actorId: fx.ids.owner };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
async function plan(s: Scenario) {
  const planId = (await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'SYN private funding',98765,'SYN') RETURNING id", [s.patientId])).rows[0].id;
  const itemId = (await fx.pool.query("INSERT INTO plan_items(plan_id,service_name,unit_price_minor,quantity,case_id) VALUES($1,'SYN current service',98765,1,$2) RETURNING id", [planId, s.bridgeId])).rows[0].id;
  return { planId, itemId };
}

const read = async (key: Key, s: Scenario, edit = true, revisionId?: number) => reads.readCanonicalOrthoStrategy(await fx.session(key), s.caseId, revisionId, edit);
it.each(["own", "all", "owner"] as const)("%s explicitly obtains bounded clinical editor choices, never a default writer", async key => {
  const s = await scenario(); await plan(s);
  expect(await read(key, s, false)).toMatchObject({ clinicalWritable: false, canRevise: false, choices: { problems: [], planItems: [] } });
  const result = await read(key, s);
  expect(result).toMatchObject({ clinicalWritable: true, canRevise: true, choices: { problems: [{ id: s.problemId, label: "SYN original problem" }] } });
  expect(JSON.stringify(result)).not.toMatch(/98765|private funding|unit_price|total_minor|invoice|balance/);
  expect(result.choices.planItems.length).toBe(key === "owner" ? 1 : 0);
});
it.each(["read", "none", "unlinked"] as const)("%s cannot obtain editing data by role or URL", async key => {
  await expect(read(key, await scenario())).rejects.toThrow(/CAPABILITY|SCOPE|UNLINKED|مصرّح/);
});
it("rejects ambiguous and unsupported edit URL values", () => {
  expect(reads.canonicalStrategyQuery("1", new URLSearchParams("edit=1&revisionId=2"))).toEqual({ caseId: 1, revisionId: 2, edit: true });
  for (const value of ["edit=0", "edit=true", "edit=1&edit=1", "edit=", "edit=1&force=1"]) expect(() => reads.canonicalStrategyQuery("1", new URLSearchParams(value))).toThrow();
});
it("outside is indistinguishable from missing; absent bridge is never created", async () => {
  const outside = await scenario(false), errors = [];
  for (const caseId of [outside.caseId, 2147483647]) try { await read("own", { ...outside, caseId }); throw Error("unexpected"); }
  catch (e) { errors.push({ code: (e as {code:string}).code, message: (e as Error).message }); }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("patient_not_found");
  const unlinked = await scenario(true, "active", false);
  expect(await read("own", unlinked)).toMatchObject({ state: "bridge_missing", canRevise: false, choices: { problems: [], planItems: [] } });
  expect((await fx.pool.query("SELECT id FROM clinical_cases WHERE ortho_case_id=$1", [unlinked.caseId])).rows).toEqual([]);
});
it("plan choices require independent view AND edit, while historical links retain their own view grant", async () => {
  const s = await scenario(), linked = await plan(s);
  const rows = [{ problem: { id:s.problemId,label:"SYN historical problem",site:null },objective:null,strategy:"SYN text",rationale:null,planItems:[{id:linked.itemId,serviceName:"SYN authored service",toothCode:null,caseSite:null}]}];
  await seedCanonicalStrategy(fx.pool, {...s,rows});
  for (const key of ["own", "planView"] as const) {
    const value = await read(key,s); expect(value.canRevise).toBe(false); expect(value.choices.planItems).toEqual([]);
    expect(value.revision?.rows[0].planLinks.state).toBe(key === "own" ? "restricted" : "allowed");
    expect(JSON.stringify(value)).not.toContain("SYN current service");
  }
  expect(await read("planEdit",s)).toMatchObject({canRevise:true,planLinksWritable:true,choices:{planItems:[{id:linked.itemId,serviceName:"SYN current service"}]}});
});
it("choices exclude foreign and other-bridge records even for owner and keep existing closed-reference meanings", async () => {
  const s = await scenario(), foreign = await scenario(false), linked = await plan(s); await plan(foreign);
  await fx.pool.query("INSERT INTO patient_problems(patient_id,label,noted_by) VALUES($1,'SYN OTHER BRIDGE','SYN')",[s.patientId]);
  await fx.pool.query("UPDATE patient_problems SET status='resolved',resolved_at=NOW(),resolved_by='SYN' WHERE id=$1",[s.problemId]);
  const value = await read("owner",s); expect(value.choices.problems).toHaveLength(1); expect(value.choices.planItems).toHaveLength(1);
  expect(value.choices.problems[0].status).toBe("resolved"); expect(value.choices.planItems[0].id).toBe(linked.itemId);
  expect(JSON.stringify(value)).not.toContain("SYN OTHER BRIDGE");
});
it("128 combined choices are complete;129 refuses editing without breaking reference reads", async () => {
  const s = await scenario();
  await fx.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) SELECT $1,$2,'SYN choice '||n,'SYN' FROM generate_series(1,127)n",[s.patientId,s.bridgeId]);
  expect((await read("owner",s)).choices.problems).toHaveLength(128);
  await plan(s); await expect(read("owner",s)).rejects.toMatchObject({status:409,code:"strategy_choice_limit"});
  expect((await read("own",s)).choices.problems).toHaveLength(128);
  await fx.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'SYN over','SYN')",[s.patientId,s.bridgeId]);
  await expect(read("own",s)).rejects.toMatchObject({status:409,code:"strategy_choice_limit"});
  expect(await read("owner",s,false)).toMatchObject({state:"ready",choices:{problems:[],planItems:[]}});
});
it("one read-only RR lease holds history, choices and grants without writes or mixed concurrent content", async () => {
  const s = await scenario(), linked=await plan(s), session=await fx.session("owner");
  const before=(await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int a,(SELECT count(*) FROM ortho_strategy_revisions)::int r,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_items i) i")).rows;
  const pool=db.getPool(),connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),original=store.readOrthoStrategyHistoryWith;
  const spy=vi.spyOn(store,"readOrthoStrategyHistoryWith").mockImplementationOnce(async(q,scope)=>{
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    await side.query("UPDATE patient_problems SET label='SYN concurrent' WHERE id=$1",[s.problemId]); return original(q,scope);
  });
  try { const value=await reads.readCanonicalOrthoStrategy(session,s.caseId,undefined,true); expect(value.choices.problems[0].label).toBe("SYN original problem");expect(value.choices.planItems[0].id).toBe(linked.itemId);expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled(); }
  finally {spy.mockRestore();connect.mockRestore();query.mockRestore();}
  expect((await read("owner",s)).choices.problems[0].label).toBe("SYN concurrent");
  expect((await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int a,(SELECT count(*) FROM ortho_strategy_revisions)::int r,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_items i) i")).rows).toEqual(before);
});
it("revoked edit grant after a real fence wait discards old read and refuses a fresh editor", async () => {
  const s=await scenario(),session=await fx.session("all"),holder=await side.connect();
  try {
    await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"clinical.ortho.view":true},patientScope:"all"},2)),fx.ids.all]);
    const pending=reads.readCanonicalOrthoStrategy(session,s.caseId,undefined,true);pending.catch(()=>undefined);
    try {expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);} finally {await holder.query("COMMIT");}
    await expect(pending).rejects.toThrow(/STALE/);await expect(read("all",s)).rejects.toMatchObject({status:403});
    expect(await read("all",s,false)).toMatchObject({clinicalWritable:false});
  } finally {await holder.query("ROLLBACK");holder.release();await fx.setGrants("all",EDIT,{patientScope:"all"});}
});
it("session expiry behind the real fence cannot publish editor choices", async () => {
  const s=await scenario(),session=await fx.session("own",1500),holder=await side.connect();
  try {
    await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);
    const pending=reads.readCanonicalOrthoStrategy(session,s.caseId,undefined,true);pending.catch(()=>undefined);
    try {expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await new Promise(r=>setTimeout(r,1700));} finally {await holder.query("COMMIT");}
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally {await holder.query("ROLLBACK");holder.release();}
});
it("an own empty-link command receipt can be verified without granting plan reading or accepting hidden links",async()=>{
  const s=await scenario(),command={schemaVersion:1 as const,commandId:"synthetic_empty_link_receipt_01",expectedRevisionId:null,reason:"SYN receipt evidence",rows:[{problemId:s.problemId,objective:null,strategy:"SYN written",rationale:null,planItemIds:[] as number[]}]};
  const {commandCanonicalOrthoStrategy}=await import("../../lib/canonical-ortho-strategy-command");
  const {strategyProjectionMatchesCommand}=await import("../../lib/ortho-strategy-client");
  const result=await commandCanonicalOrthoStrategy(await fx.session("own"),String(s.caseId),command);
  expect(strategyProjectionMatchesCommand(result.revision,command)).toBe(true);
  expect(result.revision.rows[0].planLinks).toEqual({state:"allowed",items:[]});
  const replay=await commandCanonicalOrthoStrategy(await fx.session("own"),String(s.caseId),command);expect(replay.replayed).toBe(true);expect(strategyProjectionMatchesCommand(replay.revision,command)).toBe(true);
  expect((await read("own",s,false)).revision?.rows[0].planLinks).toEqual({state:"restricted"});
  const linked=await plan(s);await expect(commandCanonicalOrthoStrategy(await fx.session("own"),String(s.caseId),{...command,commandId:"synthetic_nonempty_link_receipt_02",expectedRevisionId:result.revision.revisionId,rows:[{...command.rows[0],planItemIds:[linked.itemId]}]})).rejects.toMatchObject({status:403,code:"plan_links_unavailable"});
  expect(strategyProjectionMatchesCommand({...result.revision,rows:result.revision.rows.map(row=>({...row,planLinks:{state:"restricted" as const}}))},command)).toBe(false);
});
