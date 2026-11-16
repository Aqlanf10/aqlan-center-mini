/** Slice 32: real PostgreSQL authority, saved strategy projection and snapshot. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalStrategy } from "../fixtures/canonical-ortho-strategy";
vi.mock("server-only", () => ({}));
assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-strategy-secret-0123456789abcdef");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ortho-strategy");
const store = await import("../../lib/ortho-treatment-strategy-store");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const VIEW = { "clinical.ortho.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-OS-OWNER", role: "admin" },
  own: { username: "SYN-OS-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-OS-ALL", role: "reception", patientScope: "all", grants: VIEW },
  plans: { username: "SYN-OS-PLANS", role: "reception", patientScope: "all", grants: { ...VIEW, "clinical.plans.view": true } },
  adjacent: { username: "SYN-OS-ADJACENT", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "SYN-OS-NONE", role: "doctor", doctor: true, patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-OS-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { own: 0, outside: 0, plain: 0, bridge: 0, problem: 0, missing: 0, foreign: 0 };
let plain: Awaited<ReturnType<typeof seedCanonicalStrategy>>;
async function episode(patientId = ids.own, bridge = true) {
  const caseId = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'SYN','completed') RETURNING id", [patientId])).rows[0].id;
  const bridgeId = bridge ? (await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN bridge',$2,'SYN') RETURNING id", [patientId, caseId])).rows[0].id : 0;
  const problemId = bridge ? (await fx.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,specialty,noted_by) VALUES($1,$2,'SYN current problem','orthodontics','SYN') RETURNING id", [patientId, bridgeId])).rows[0].id : 0;
  return { patientId, caseId, bridgeId, problemId, actorId: fx.ids.owner };
}
const read = async (key: Key, caseId = ids.plain, revisionId?: number) => reads.readCanonicalOrthoStrategy(await fx.session(key), caseId, revisionId);
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  for (const key of ["own", "outside"] as const) ids[key] = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-OS-${key}`, key === "own" ? fx.parties.own! : null])).rows[0].id;
  const primary = await episode(); ids.plain = primary.caseId; ids.bridge = primary.bridgeId; ids.problem = primary.problemId;
  plain = await seedCanonicalStrategy(fx.pool, primary);
  ids.missing = (await episode(ids.own, false)).caseId; ids.foreign = (await episode(ids.outside)).caseId;
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it("registers the mapped capability and patient scope", () => {
  expect(CANONICAL_RECORD_READS["read:ortho.strategy"]).toEqual({ record: "patient", need: ["clinical.ortho.view"], anyOf: [] });
});
it.each(["own", "all", "owner"] as const)("%s reads exact saved clinical text without admitting a writer", async key => {
  const result = await read(key);
  expect(result).toMatchObject({ ok: true, state: "ready", clinicalWritable: false, planLinksWritable: false, canRevise: false,
    revision: { revisionId: plain.id, rows: [{ objective: "SYN saved objective", problem: { label: "SYN saved problem" } }] }, choices: { problems: [], planItems: [] } });
  expect(JSON.stringify(result)).not.toMatch(/invoice|price|balance|storage|phone|SYN current problem/);
});
it.each(["none", "unlinked", "adjacent"] as const)("denies %s without role expansion", async key => {
  await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);
});
it("outside and missing have one response; a legitimate missing bridge or empty history remains distinct", async () => {
  const errors = [];
  for (const id of [ids.foreign, 2147483647]) try { await read("own", id); throw Error("unexpected"); } catch (e) { errors.push({ code: (e as { code: string }).code, message: (e as Error).message }); }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("patient_not_found");
  expect(await read("own", ids.missing)).toMatchObject({ state: "bridge_missing", revision: null, history: [] });
  expect(await read("own", (await episode()).caseId)).toMatchObject({ state: "ready", revision: null, history: [] });
});
it.each(["revisionId=0", "revisionId=01", "revisionId=1&revisionId=1", "patientId=1", "photos=1", "revisionId=2147483648"])("rejects ambiguous or unsupported query %s", query => {
  expect(() => reads.canonicalStrategyQuery("1", new URLSearchParams(query))).toThrow();
});
it("selects exact saved versions and refuses another case's revision", async () => {
  const scope = await episode(), first = await seedCanonicalStrategy(fx.pool, scope);
  const second = await seedCanonicalStrategy(fx.pool, { ...scope, version: 2, previous: first.id, reason: "SYN later" });
  expect((await read("own", scope.caseId)).revision?.revisionId).toBe(second.id);
  expect((await read("own", scope.caseId, first.id)).revision?.reason).toBe("SYN saved reason");
  await expect(read("own", scope.caseId, plain.id)).rejects.toMatchObject({ status: 404, code: "revision_not_found" });
});
async function linkedEpisode() {
  const scope = await episode();
  const planId = (await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'SYN private funding title',9900,'SYN') RETURNING id", [scope.patientId])).rows[0].id;
  const itemId = (await fx.pool.query("INSERT INTO plan_items(plan_id,service_name,tooth_code,unit_price_minor,quantity,case_id) VALUES($1,'SYN CURRENT PLAN',21,9900,1,$2) RETURNING id", [planId, scope.bridgeId])).rows[0].id;
  const rows = [{ problem: { id: scope.problemId, label: "SYN saved problem", site: "upper" }, objective: "SYN objective", strategy: "SYN clinical strategy", rationale: null,
    planItems: [{ id: itemId, serviceName: "SYN SAVED PLAN", toothCode: 21, caseSite: "upper" }] }];
  const saved = await seedCanonicalStrategy(fx.pool, { ...scope, rows });
  return { ...scope, planId, itemId, saved };
}
it("plan links have an independent grant in current and selected historical revisions; no finance or editing choices", async () => {
  const scope = await linkedEpisode();
  for (const id of [undefined, scope.saved.id]) {
    const denied = await read("own", scope.caseId, id);
    expect(denied.revision?.rows[0].planLinks).toEqual({ state: "restricted" });
    expect(JSON.stringify(denied)).not.toMatch(/SYN SAVED PLAN|SYN CURRENT PLAN|funding title|unitPrice|9900/);
  }
  for (const key of ["owner", "plans"] as const) {
    const result = await read(key, scope.caseId);
    expect(result.revision?.rows[0].planLinks).toMatchObject({ state: "allowed", items: [{ serviceName: "SYN SAVED PLAN" }] });
    expect(JSON.stringify(result)).not.toMatch(/SYN CURRENT PLAN|funding title|9900/);
  }
});
it("current moved or foreign references never substitute names into historical clinical documentation", async () => {
  const scope = await linkedEpisode();
  await fx.pool.query("UPDATE patient_problems SET case_id=NULL,label='SYN changed private label' WHERE id=$1", [scope.problemId]);
  expect((await read("owner", scope.caseId)).revision?.rows[0]).toMatchObject({ problem: { label: "SYN saved problem" }, currentProblem: { state: "moved", status: null } });
  await fx.pool.query("UPDATE treatment_plans SET patient_id=$1 WHERE id=$2", [ids.outside, scope.planId]);
  const result = await read("owner", scope.caseId);
  expect(result.revision?.rows[0].planLinks).toMatchObject({ state: "allowed", items: [{ serviceName: "SYN SAVED PLAN", current: { state: "unavailable", status: null } }] });
  expect(JSON.stringify(result)).not.toContain("SYN changed private label");
});
it("a lost bridge never disguises existing history as an empty record", async () => {
  const scope = await episode(); await seedCanonicalStrategy(fx.pool, scope);
  await fx.pool.query("UPDATE clinical_cases SET ortho_case_id=NULL WHERE id=$1", [scope.bridgeId]);
  await expect(read("owner", scope.caseId)).rejects.toMatchObject({ status: 409, code: "scope_mismatch" });
});
it("rejects a malformed stored revision without changing or concealing it", async () => {
  const scope = await episode();
  // Deliberately malformed historical fixture: satisfies the SQL array constraint, not the application decoder. No immutable row is edited.
  const rows = [{invalidStoredShape:true}] as unknown as Parameters<typeof seedCanonicalStrategy>[1]["rows"];
  await seedCanonicalStrategy(fx.pool, {...scope, rows});
  await expect(read("owner", scope.caseId)).rejects.toMatchObject({ status: 500 });
  expect((await fx.pool.query("SELECT rows FROM ortho_strategy_revisions WHERE ortho_case_id=$1", [scope.caseId])).rows).toEqual([{ rows: [{ invalidStoredShape: true }] }]);
});
it("one RR read-only lease covers authority, history and current references without pool reads or writes", async () => {
  const sql = "SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM ortho_strategy_revisions)::int revisions";
  const before = (await fx.pool.query(sql)).rows, session = await fx.session("own"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), original = store.readOrthoStrategyHistoryWith;
  const spy = vi.spyOn(store, "readOrthoStrategyHistoryWith").mockImplementationOnce(async (q, scope) => {
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on"); return original(q, scope);
  });
  try { await reads.readCanonicalOrthoStrategy(session, ids.plain); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); spy.mockRestore(); }
  expect((await fx.pool.query(sql)).rows).toEqual(before);
});
it("a concurrent reference update cannot mix its new state into an admitted old snapshot", async () => {
  const original = store.readOrthoStrategyHistoryWith;
  const spy = vi.spyOn(store, "readOrthoStrategyHistoryWith").mockImplementationOnce(async (q, scope) => {
    await side.query("UPDATE patient_problems SET case_id=NULL WHERE id=$1", [ids.problem]); return original(q, scope);
  });
  try { expect((await read("own")).revision?.rows[0].currentProblem.state).toBe("available"); spy.mockRestore(); expect((await read("own")).revision?.rows[0].currentProblem.state).toBe("moved"); }
  finally { spy.mockRestore(); await side.query("UPDATE patient_problems SET case_id=$1 WHERE id=$2", [ids.bridge, ids.problem]); }
});
it("expires a session waiting behind the lifecycle fence", async () => {
  const session = await fx.session("own", 1500), holder = await side.connect();
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalOrthoStrategy(session, ids.plain); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("revalidates permissions after the real fence wait", async () => {
  const stale = await fx.session("all"), holder = await side.connect();
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 2)), fx.ids.all]);
    const pending = reads.readCanonicalOrthoStrategy(stale, ids.plain); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/); await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("revoking the plan capability retires old sessions and removes only plan links from a fresh read", async () => {
  const scope = await linkedEpisode(), stale = await fx.session("plans");
  await fx.setGrants("plans", VIEW, { patientScope: "all" });
  try {
    await expect(reads.readCanonicalOrthoStrategy(stale, scope.caseId)).rejects.toThrow(/STALE/);
    expect((await read("plans", scope.caseId)).revision?.rows[0].planLinks).toEqual({ state: "restricted" });
  } finally { await fx.setGrants("plans", { ...VIEW, "clinical.plans.view": true }, { patientScope: "all" }); }
});
it("bounds complete history by bytes before materializing rows, without truncation or mutation", async () => {
  const scope = await episode(); let previous: number | null = null;
  const rows = Array.from({ length: 30 }, () => ({ problem: { id: scope.problemId, label: "SYN", site: null }, objective: "x".repeat(1000), strategy: "x".repeat(2000), rationale: "x".repeat(1000), planItems: [] }));
  for (let version = 1; version <= 72; version++) previous = (await seedCanonicalStrategy(fx.pool, { ...scope, rows, version, previous })).id;
  await expect(read("owner", scope.caseId)).rejects.toMatchObject({ status: 409, code: "strategy_history_limit" });
  expect((await fx.pool.query("SELECT count(*)::int n FROM ortho_strategy_revisions WHERE ortho_case_id=$1", [scope.caseId])).rows[0].n).toBe(72);
});
it("bounds the union of historical references rather than silently dropping old rows", async () => {
  const scope = await episode(); let previous: number | null = null;
  const problems = (await fx.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) SELECT $1,$2,'SYN union','SYN' FROM generate_series(1,130) RETURNING id", [scope.patientId, scope.bridgeId])).rows;
  for (let version = 1; version <= 5; version++) {
    const rows = problems.slice((version - 1) * 26, version * 26).map(p => ({ problem: { id: p.id, label: "SYN", site: null }, objective: null, strategy: "SYN", rationale: null, planItems: [] }));
    previous = (await seedCanonicalStrategy(fx.pool, { ...scope, rows, version, previous })).id;
  }
  await expect(read("owner", scope.caseId)).rejects.toMatchObject({ status: 409, code: "strategy_reference_limit" });
});
it("a failed domain query rejects the full read and leaves the next lease usable", async () => {
  const spy = vi.spyOn(store, "readOrthoStrategyHistoryWith").mockImplementationOnce(q => q.query("SELECT 1/0").then(() => ({ stored: [], revisions: [] })));
  try { await expect(read("own")).rejects.toThrow(); } finally { spy.mockRestore(); }
  expect((await read("own")).revision?.revisionId).toBe(plain.id);
});
it("patient scope none and retired session epoch are checked again on every read", async () => {
  const stale = await fx.session("own");
  await fx.setGrants("own", VIEW, { patientScope: "none" });
  try {
    await expect(reads.readCanonicalOrthoStrategy(stale, ids.plain)).rejects.toThrow(/STALE/);
    await expect(read("own")).rejects.toThrow(/RECORD_SCOPE_DENIED/);
  } finally { await fx.setGrants("own", VIEW, { patientScope: "own" }); }
  const old = await fx.session("own");
  await fx.pool.query("UPDATE users SET password_hash='synthetic-revoked-strategy-hash' WHERE id=$1", [fx.ids.own]);
  await expect(reads.readCanonicalOrthoStrategy(old, ids.plain)).rejects.toThrow(/SESSION|STALE/);
  expect((await read("own")).revision?.revisionId).toBe(plain.id);
});
it("scope membership changes remain snapshot consistent and deny the following read", async () => {
  const original = store.readOrthoStrategyHistoryWith;
  const spy = vi.spyOn(store, "readOrthoStrategyHistoryWith").mockImplementationOnce(async (q, scope) => {
    await side.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.own]); return original(q, scope);
  });
  try {
    expect((await read("own")).revision?.revisionId).toBe(plain.id); spy.mockRestore();
    await expect(read("own")).rejects.toMatchObject({code:"patient_not_found"});
  } finally {spy.mockRestore();await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own,ids.own]);}
});
it("refuses a complete lineage above 5000 revisions before decoding it, without silently truncating", async () => {
  const scope = await episode();
  const rows = JSON.stringify([{problem:{id:scope.problemId,label:"SYN",site:null},objective:null,strategy:"SYN",rationale:null,planItems:[]}]);
  await fx.pool.query(`WITH allocated AS MATERIALIZED (
    SELECT n,nextval(pg_get_serial_sequence('ortho_strategy_revisions','id')) AS id FROM generate_series(1,5001) n
  ), chain AS (SELECT n,id,lag(id) OVER(ORDER BY n) AS previous FROM allocated)
  INSERT INTO ortho_strategy_revisions(id,patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,rows)
  SELECT id,$1,$1,$2,$3,1,n,previous,$4,'SYN','SYN','retrospective',gen_random_uuid()::text,repeat('a',64),$5::jsonb FROM chain`,
  [scope.patientId,scope.caseId,scope.bridgeId,scope.actorId,rows]);
  await expect(read("owner",scope.caseId)).rejects.toMatchObject({status:409,code:"strategy_history_limit"});
  expect((await fx.pool.query("SELECT count(*)::int n FROM ortho_strategy_revisions WHERE ortho_case_id=$1",[scope.caseId])).rows[0].n).toBe(5001);
});
