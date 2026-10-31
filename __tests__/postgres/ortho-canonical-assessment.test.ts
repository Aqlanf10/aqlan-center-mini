/** Slice 31: real PG, native immutable revisions and independent source authority. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalAssessment } from "../fixtures/canonical-ortho-assessment";
vi.mock("server-only", () => ({}));
assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-assessment-secret-0123456789abcdef");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ortho-assessment");
const store = await import("../../lib/ortho-assessment-store");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const VIEW = { "clinical.ortho.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-OA-OWNER", role: "admin" },
  own: { username: "SYN-OA-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-OA-ALL", role: "reception", patientScope: "all", grants: VIEW },
  imaging: { username: "SYN-OA-IMAGING", role: "reception", patientScope: "all", grants: { ...VIEW, "clinical.xrays.view": true } },
  care: { username: "SYN-OA-CARE", role: "reception", patientScope: "all", grants: { ...VIEW, "clinical.plans.view": true } },
  adjacent: { username: "SYN-OA-ADJACENT", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true } },
  none: { username: "SYN-OA-NONE", role: "doctor", doctor: true, patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-OA-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { own: 0, outside: 0, plain: 0, bridge: 0, missing: 0, foreign: 0 };
let plain: Awaited<ReturnType<typeof seedCanonicalAssessment>>;
async function episode(patientId = ids.own, bridge = true) {
  const caseId = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'SYN','completed') RETURNING id", [patientId])).rows[0].id;
  const bridgeId = bridge ? (await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN bridge',$2,'SYN') RETURNING id", [patientId, caseId])).rows[0].id : 0;
  return { patientId, caseId, bridgeId, actorId: fx.ids.owner };
}
const read = async (key: Key, caseId = ids.plain, revisionId?: number) => reads.readCanonicalOrthoAssessment(await fx.session(key), caseId, revisionId);
async function document(input: Awaited<ReturnType<typeof episode>>) {
  const id = (await fx.pool.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,ortho_case_id) VALUES($1,'imaging','SYN private title','image/png',1,$2,'SYN/no-file.png','SYN',$3) RETURNING id", [input.patientId, "a".repeat(64), input.caseId])).rows[0].id;
  return { kind: "document" as const, id, version: `sha256:${"a".repeat(64)}` };
}
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  for (const key of ["own", "outside"] as const) ids[key] = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-OA-${key}`, key === "own" ? fx.parties.own! : null])).rows[0].id;
  const primary = await episode(); ids.plain = primary.caseId; ids.bridge = primary.bridgeId; plain = await seedCanonicalAssessment(fx.pool, primary);
  ids.missing = (await episode(ids.own, false)).caseId; ids.foreign = (await episode(ids.outside)).caseId;
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it("registers the mapped capability and patient record scope", () => {
  expect(CANONICAL_RECORD_READS["read:ortho.assessment"]).toEqual({ record: "patient", need: ["clinical.ortho.view"], anyOf: [] });
});
it("plain own assessment preserves exact historical content and hashes without financial or source-picker payloads", async () => {
  const result = await read("own");
  expect(result).toMatchObject({ ok: true, representation: 2, state: "ready", clinicalWritable: false, revision: { id: plain.id, contentHash: plain.hash, content: plain.content }, sources: { items: [], truncated: true } });
  expect(JSON.stringify(result)).not.toMatch(/storage_key|planId|invoice|legacyFinancialMode|SYN private title/);
});
it.each(["all", "owner"] as const)("%s reads the same immutable clinical representation without admitting writes", async key => {
  expect((await read(key)).revision?.contentHash).toBe(plain.hash); expect((await read(key)).clinicalWritable).toBe(false);
});
it.each(["none", "unlinked", "adjacent"] as const)("denies %s without role or neighboring-capability expansion", async key => {
  await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);
});
it("missing and outside are the same 404; a legitimate missing bridge or empty history is distinct", async () => {
  const errors = [];
  for (const id of [ids.foreign, 2147483647]) try { await read("own", id); throw Error("unexpected"); } catch (error) { errors.push({code:(error as {code:string}).code,message:(error as Error).message}); }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("patient_not_found");
  expect(await read("own", ids.missing)).toMatchObject({ state: "bridge_missing", revision: null, history: [] });
  expect(await read("own", (await episode()).caseId)).toMatchObject({ state: "ready", revision: null, history: [] });
});
it.each(["acceptSchema=1", "acceptSchema=2&acceptSchema=2", "acceptSchema=2&revisionId=0", "acceptSchema=2&revisionId=01", "acceptSchema=2&photos=1", "acceptSchema=2&patientId=1", "acceptSchema=2&revisionId=2147483648"])("rejects unsupported or ambiguous query %s", query => {
  expect(() => reads.canonicalAssessmentQuery("1", new URLSearchParams(query))).toThrow();
});
it("requires explicit schema negotiation and a revision from this case", async () => {
  expect(() => reads.canonicalAssessmentQuery("1", new URLSearchParams())).toThrow(/الإصدار/);
  expect(reads.canonicalAssessmentQuery("1", new URLSearchParams("acceptSchema=2"))).toEqual({ caseId: 1, revisionId: undefined });
  await expect(read("own", ids.plain, 2147483647)).rejects.toMatchObject({ status: 404, code: "revision_not_found" });
});
it("rejects corrupted hashes and unsupported historical schema without repairing them", async () => {
  for (const extra of [{badHash:true}, {schemaVersion:1}] as const) {
    const scope = await episode(); await seedCanonicalAssessment(fx.pool, {...scope,...extra});
    const before = (await fx.pool.query("SELECT content,content_sha256 FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [scope.caseId])).rows;
    await expect(read("owner", scope.caseId)).rejects.toMatchObject({ status: 409 });
    expect((await fx.pool.query("SELECT content,content_sha256 FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [scope.caseId])).rows).toEqual(before);
  }
});
it("database refuses a gap in immutable revision versions and the reader preserves the intact head", async () => {
  const scope=await episode(),first=await seedCanonicalAssessment(fx.pool,scope);
  await expect(seedCanonicalAssessment(fx.pool,{...scope,version:3,previous:first.id})).rejects.toThrow(/lineage/i);
  expect((await read("owner",scope.caseId)).revision?.contentHash).toBe(first.hash);
});
it("imaging references require their independent grant, without fetching document titles or files into the response", async () => {
  const scope = await episode(), source = await document(scope); await seedCanonicalAssessment(fx.pool, {...scope,sources:[source]});
  await expect(read("own", scope.caseId)).rejects.toMatchObject({ status: 403, code: "source_restricted" });
  await expect(read("care", scope.caseId)).rejects.toMatchObject({ status: 403 });
  const result = await read("imaging", scope.caseId);
  expect(result.sourceStates).toEqual([{ source, state: "available" }]);
  expect(JSON.stringify(result)).not.toMatch(/SYN private title|SYN\/no-file|storage|mime|data:image/);
});
it("medical-history-derived assessment data follow the existing independent care group", async () => {
  const scope = await episode();
  const hid = (await fx.pool.query("INSERT INTO patient_medical_history(patient_id,recorded_by,notes) VALUES($1,'SYN','SYN private history') RETURNING id", [scope.patientId])).rows[0].id;
  const source = {kind:"patient_history" as const,id:hid,version:"historical-witness"};
  await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
  await expect(read("own",scope.caseId)).rejects.toMatchObject({status:403,code:"source_restricted"});
  const result=await read("care",scope.caseId);expect(result.sourceStates).toEqual([{source,state:"changed"}]);
  expect(JSON.stringify(result)).not.toContain("SYN private history");
});
it("changing or removing an owned source preserves the saved result; foreign or missing ownership refuses the whole read", async () => {
  const scope = await episode(), source = await document(scope), saved = await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
  await fx.pool.query("UPDATE patient_documents SET sha256=$1 WHERE id=$2",["b".repeat(64),source.id]);
  let result=await read("imaging",scope.caseId);expect(result.revision?.contentHash).toBe(saved.hash);expect(result.sourceStates[0].state).toBe("changed");
  await fx.pool.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1",[source.id]);
  result=await read("imaging",scope.caseId);expect(result.revision?.contentHash).toBe(saved.hash);expect(result.sourceStates[0].state).toBe("unavailable");
  await fx.pool.query("UPDATE patient_documents SET patient_id=$1 WHERE id=$2",[ids.outside,source.id]);
  await expect(read("owner",scope.caseId)).rejects.toMatchObject({status:403,code:"source_restricted"});
});
it("a restricted ancestor cannot be disclosed through history, copies or an older revisionId", async () => {
  const scope=await episode(),source=await document(scope),first=await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
  const second=await seedCanonicalAssessment(fx.pool,{...scope,version:2,previous:first.id,sources:[{kind:"assessment_revision",id:first.id,version:`sha256:${first.hash}`}]});
  await seedCanonicalAssessment(fx.pool,{...scope,version:3,previous:second.id});
  for(const id of [undefined,first.id,second.id])await expect(read("own",scope.caseId,id)).rejects.toMatchObject({status:403,code:"source_restricted"});
  expect((await read("imaging",scope.caseId,first.id)).revision?.contentHash).toBe(first.hash);
  expect((await read("imaging",scope.caseId,second.id)).sourceStates).toHaveLength(2);
});
it("one read-only RR lease covers admission, history and sources with no hidden pool reads or data writes", async () => {
  const before=(await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM ortho_assessment_revisions)::int AS revisions")).rows;
  const session=await fx.session("own"),pool=db.getPool(),connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),original=store.readOrthoAssessmentHistoryWith;
  const spy=vi.spyOn(store,"readOrthoAssessmentHistoryWith").mockImplementationOnce(async(q,scope)=>{
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");return original(q,scope);
  });
  try{await reads.readCanonicalOrthoAssessment(session,ids.plain);expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();}
  finally{connect.mockRestore();query.mockRestore();spy.mockRestore();}
  expect((await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM ortho_assessment_revisions)::int AS revisions")).rows).toEqual(before);
});
it("membership and assessment history stay coherent across a concurrent patient transfer", async () => {
  const original=store.readOrthoAssessmentHistoryWith;
  const spy=vi.spyOn(store,"readOrthoAssessmentHistoryWith").mockImplementationOnce(async(q,scope)=>{
    await side.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[ids.own]);return original(q,scope);
  });
  try{expect((await read("own")).revision?.contentHash).toBe(plain.hash);spy.mockRestore();await expect(read("own")).rejects.toMatchObject({code:"patient_not_found"});}
  finally{spy.mockRestore();await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2",[fx.parties.own!,ids.own]);}
});
it("expires a session waiting behind the real lifecycle fence", async () => {
  const session = await fx.session("own", 1500), holder = await side.connect();
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalOrthoAssessment(session, ids.plain); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("re-proves permissions after waiting behind revocation; new sessions cannot regain access from a role label", async () => {
  const stale = await fx.session("all"), holder = await side.connect();
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 2)), fx.ids.all]);
    const pending = reads.readCanonicalOrthoAssessment(stale, ids.plain); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/);
    await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("rejects scope revocation and inactive clinician links on subsequent reads", async () => {
  const stale = await fx.session("own");
  await fx.setGrants("own", VIEW, { patientScope: "none" });
  try { await expect(reads.readCanonicalOrthoAssessment(stale, ids.plain)).rejects.toThrow(/STALE/); await expect(read("own")).rejects.toThrow(/RECORD_SCOPE_DENIED/); }
  finally { await fx.setGrants("own", VIEW, { patientScope: "own" }); }
  await fx.pool.query("UPDATE parties SET is_active=FALSE WHERE id=$1", [fx.parties.own!]);
  try { await expect(read("own")).rejects.toThrow("STAFF_OPERATION_PROVIDER_STALE"); }
  finally { await fx.pool.query("UPDATE parties SET is_active=TRUE WHERE id=$1", [fx.parties.own!]); }
});
it("clinical-visit references need the care group and stay bound to this patient and clinical case", async () => {
  const scope=await episode();
  const id=(await fx.pool.query("INSERT INTO visits(patient_name,patient_id,case_id,chief_complaint) VALUES('SYN',$1,$2,'SYN private visit') RETURNING id",[scope.patientId,scope.bridgeId])).rows[0].id;
  const source={kind:"clinical_visit" as const,id,version:"historical-witness"};await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
  await expect(read("own",scope.caseId)).rejects.toMatchObject({status:403});
  expect((await read("care",scope.caseId)).sourceStates).toEqual([{source,state:"changed"}]);
  await fx.pool.query("UPDATE visits SET case_id=NULL WHERE id=$1",[id]);
  await expect(read("owner",scope.caseId)).rejects.toMatchObject({status:403,code:"source_restricted"});
});
it("ceph sources use the existing clinical hash and backing-document ownership without exposing images", async () => {
  const scope=await episode(),doc=await document(scope);
  const ceph=await db.createCephAnalysis({patientId:scope.patientId,documentId:doc.id,createdBy:"SYN",orthoCaseId:scope.caseId,xrayDate:null});
  if(!ceph.ok)throw Error(ceph.message);
  const source={kind:"ceph_study" as const,id:Number(ceph.id),version:"historical-witness"};await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
  await expect(read("care",scope.caseId)).rejects.toMatchObject({status:403});
  const result=await read("imaging",scope.caseId);expect(result.sourceStates).toEqual([{source,state:"changed"}]);
  expect(JSON.stringify(result)).not.toMatch(/storage|landmarks|mime|SYN private title/);
});
it("missing, foreign or broken assessment-source witnesses are refused, not replaced by inferred sources", async () => {
  const other=await episode(ids.outside),foreign=await seedCanonicalAssessment(fx.pool,other);
  for(const source of [{kind:"assessment_revision" as const,id:foreign.id,version:`sha256:${foreign.hash}`},{kind:"document" as const,id:2147483647,version:"missing"}]) {
    const scope=await episode();await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
    await expect(read("owner",scope.caseId)).rejects.toMatchObject({status:expect.any(Number)});
  }
});
it("bounds the aggregate source union without silently truncating revisions", async () => {
  const scope=await episode();let previous:number|null=null;
  for(let v=1;v<=5;v++) {
    const sources=[];for(let n=0;n<26;n++)sources.push(await document(scope));
    previous=(await seedCanonicalAssessment(fx.pool,{...scope,version:v,previous,sources})).id;
  }
  await expect(read("owner",scope.caseId)).rejects.toMatchObject({status:409,code:"source_reference_limit"});
  expect((await fx.pool.query("SELECT count(*)::int n FROM ortho_assessment_revisions WHERE ortho_case_id=$1",[scope.caseId])).rows[0].n).toBe(5);
});
it("a database failure rejects the entire read and leaves a usable next lease", async () => {
  const spy=vi.spyOn(store,"readOrthoAssessmentHistoryWith").mockImplementationOnce(q=>q.query("SELECT 1/0").then(()=>({rows:[],revisions:[]})));
  try{await expect(read("own")).rejects.toThrow();}finally{spy.mockRestore();}
  expect((await read("own")).revision?.contentHash).toBe(plain.hash);
});
it("a concurrent source edit cannot mix its new witness with an admitted old snapshot", async () => {
  const scope=await episode(),source=await document(scope);await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
  const original=store.readOrthoAssessmentHistoryWith,spy=vi.spyOn(store,"readOrthoAssessmentHistoryWith").mockImplementationOnce(async(q,s)=>{
    await side.query("UPDATE patient_documents SET sha256=$1 WHERE id=$2",["c".repeat(64),source.id]);return original(q,s);
  });
  try{expect((await read("imaging",scope.caseId)).sourceStates[0].state).toBe("available");}finally{spy.mockRestore();}
  expect((await read("imaging",scope.caseId)).sourceStates[0].state).toBe("changed");
});
it("revoking only the source capability invalidates stale sessions and refuses freshly authenticated ortho-only access",async()=>{
  const scope=await episode(),source=await document(scope);await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
  const stale=await fx.session("imaging");expect((await read("imaging",scope.caseId)).revision).not.toBeNull();
  await fx.setGrants("imaging",VIEW,{patientScope:"all"});
  try{await expect(reads.readCanonicalOrthoAssessment(stale,scope.caseId)).rejects.toThrow(/STALE/);await expect(read("imaging",scope.caseId)).rejects.toMatchObject({status:403,code:"source_restricted"});}
  finally{await fx.setGrants("imaging",{...VIEW,"clinical.xrays.view":true},{patientScope:"all"});}
});
it("preserves distinct historical versions of a mutable source across the whole history",async()=>{
  const scope=await episode(),source=await document(scope),first=await seedCanonicalAssessment(fx.pool,{...scope,sources:[source]});
  await fx.pool.query("UPDATE patient_documents SET sha256=$1 WHERE id=$2",["b".repeat(64),source.id]);
  const current={...source,version:`sha256:${"b".repeat(64)}`};await seedCanonicalAssessment(fx.pool,{...scope,version:2,previous:first.id,sources:[current]});
  expect((await read("imaging",scope.caseId)).sourceStates).toEqual([{source:current,state:"available"}]);
  expect((await read("imaging",scope.caseId,first.id)).sourceStates).toEqual([{source,state:"changed"}]);
});
it("a lost bridge never turns an existing historical record into an empty one",async()=>{
  const scope=await episode();await seedCanonicalAssessment(fx.pool,scope);
  await fx.pool.query("UPDATE clinical_cases SET ortho_case_id=NULL WHERE id=$1",[scope.bridgeId]);
  await expect(read("owner",scope.caseId)).rejects.toMatchObject({status:409,code:"scope_mismatch"});
});
it("source byte admission refuses oversized clinical history before reading its payload",async()=>{
  const scope=await episode(),id=(await fx.pool.query("INSERT INTO patient_medical_history(patient_id,recorded_by,notes) VALUES($1,'SYN',repeat('x',4200000)) RETURNING id",[scope.patientId])).rows[0].id;
  await seedCanonicalAssessment(fx.pool,{...scope,sources:[{kind:"patient_history",id,version:"historical-witness"}]});
  await expect(read("care",scope.caseId)).rejects.toMatchObject({status:409,code:"source_resource_limit"});
});
