import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
import type { CanonicalSnapshotQuery } from "../../lib/canonical-read-snapshot";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-patient-case-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-case-reads"), snapshots = await import("../../lib/canonical-read-snapshot");
const VIEW = { "clinical.plans.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-CASE-OWNER", role: "admin" },
  own: { username: "SYN-CASE-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-CASE-ALL", role: "reception", patientScope: "all", grants: VIEW },
  care: { username: "SYN-CASE-CARE", role: "assistant", patientScope: "all", grants: { "clinical.visits.document": true } },
  none: { username: "SYN-CASE-NONE", role: "doctor", doctor: true, patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-CASE-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
  adjacent: { username: "SYN-CASE-ADJACENT", role: "admin", patientScope: "all", grants: { "finance.patient-ledger.view": true, "appointments.create": true } },
  orthoOnly: { username: "SYN-CASE-ORTHO", role: "reception", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { patient: 0, outside: 0, plan: 0, item: 0, caseId: 0, prerequisite: 0, problemId: 0, foreignCase: 0, foreignItem: 0 };
const read = async (key: Key, patientId = ids.patient) => reads.readCanonicalPatientCases(await fx.session(key), patientId);
async function patient(label: string) { return Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$1) RETURNING id", [`SYN-CASE-${label}`])).rows[0].id); }
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  ids.patient = await patient("own"); ids.outside = await patient("outside");
  await fx.pool.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.patient]);
  Object.assign(ids, await seedCanonicalPatientCases(fx.pool, ids.patient, fx.parties.own));
  const foreign = await seedCanonicalPatientCases(fx.pool, ids.outside); ids.foreignCase = foreign.caseId; ids.foreignItem = foreign.item;
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it.each(["owner", "own", "all"] as const)("%s receives clinical case facts and a complete dependency graph", async key => {
  const body = await read(key);
  expect(Object.keys(body).sort()).toEqual(["cases", "dependencies", "items", "orthoVisible", "patientId", "planVisible", "problems", "projection"]);
  expect(body.cases).toEqual([expect.objectContaining({ id: ids.caseId, title: "SYN root case", problem: "SYN recorded problem", status: "active" })]);
  expect(body.items).toHaveLength(2); expect(body.items.find(i => i.id === ids.item)).toMatchObject({ priority: 3, caseId: ids.caseId });
  expect(body.dependencies).toEqual([{ itemId: ids.item, requiresItemId: ids.prerequisite, requirement: "completed", note: "SYN dependency note", met: true, createdBy: "SYN clinician", version: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(JSON.stringify(body)).not.toMatch(/9900123|Minor|price|currency|billing|invoice|payment|patientName|patientPhone|financial|legacy/i);
});
it.each(["none", "unlinked", "adjacent", "orthoOnly"] as const)("denies %s without treating the role or another module as a clinical grant", async key => {
  await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);
});
it("care permits cases and problems but never plan items or dependencies", async () => {
  const result = await read("care"); expect(result.cases).toHaveLength(1); expect(result.problems).toHaveLength(1);
  expect(result).toMatchObject({ planVisible: false, items: [], dependencies: [], orthoVisible: false });
});
it("foreign and missing patient records return the same refusal", async () => {
  const errors = [];
  for (const id of [ids.outside, 2147483647]) try { await read("own", id); throw Error("unexpected success"); } catch (e) { errors.push({ code: (e as { code: string }).code, message: (e as Error).message }); }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("patient_not_found");
});
it("financial mutations cannot change the clinical projection", async () => {
  const before = await read("own");
  await fx.pool.query("UPDATE treatment_plans SET total_minor=88881234,base_currency='SYN-INVALID' WHERE id=$1", [ids.plan]);
  await fx.pool.query("UPDATE plan_items SET unit_price_minor=77771234,billing_status='needs_financial_review' WHERE id=$1", [ids.item]);
  try { expect(await read("own")).toEqual(before); } finally {
    await fx.pool.query("UPDATE treatment_plans SET total_minor=9900123,base_currency='YER' WHERE id=$1", [ids.plan]);
    await fx.pool.query("UPDATE plan_items SET unit_price_minor=9900123,billing_status='unbilled' WHERE id=$1", [ids.item]);
  }
});
it.each(["item", "problem", "dependency"])("refuses a foreign %s reference without exposing its content", async kind => {
  if (kind === "item") await fx.pool.query("UPDATE plan_items SET case_id=$1 WHERE id=$2", [ids.foreignCase, ids.item]);
  if (kind === "problem") await fx.pool.query("UPDATE patient_problems SET case_id=$1 WHERE id=$2", [ids.foreignCase, ids.problemId]);
  if (kind === "dependency") await fx.pool.query("UPDATE plan_item_dependencies SET requires_item_id=$1 WHERE item_id=$2", [ids.foreignItem, ids.item]);
  try { await expect(read("owner")).rejects.toMatchObject({ code: "case_reference_unavailable" }); }
  finally {
    await fx.pool.query("UPDATE plan_items SET case_id=$1 WHERE id=$2", [ids.caseId, ids.item]);
    await fx.pool.query("UPDATE patient_problems SET case_id=$1 WHERE id=$2", [ids.caseId, ids.problemId]);
    await fx.pool.query("UPDATE plan_item_dependencies SET requires_item_id=$1 WHERE item_id=$2", [ids.prerequisite, ids.item]);
  }
});
it("a hidden plan's corruption cannot be used as a clinical read side channel", async () => {
  const before = await read("care"); await fx.pool.query("UPDATE plan_items SET case_id=$1 WHERE id=$2", [ids.foreignCase, ids.item]);
  try { expect(await read("care")).toEqual(before); } finally { await fx.pool.query("UPDATE plan_items SET case_id=$1 WHERE id=$2", [ids.caseId, ids.item]); }
});
it("ortho details require a separate grant; a bridge follows the native state without duplicating it", async () => {
  const patientId = await patient("ortho"), saved = await seedCanonicalPatientCases(fx.pool, patientId);
  const ortho = Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,plan_id,status,start_date,created_by,closed_note) VALUES($1,$2,'discontinued','2024-02-01','SYN','SYN private ortho outcome') RETURNING id", [patientId, saved.plan])).rows[0].id);
  const before = await read("all", patientId); expect(before.cases).toHaveLength(1); expect(JSON.stringify(before)).not.toContain("SYN private ortho outcome");
  const owner = await read("owner", patientId); expect(owner.cases).toHaveLength(2); expect(owner.cases.find(c => c.orthoCaseId === ortho)).toMatchObject({ id: null, kind: "ortho", status: "closed", outcome: "SYN private ortho outcome" });
  const bridge = Number((await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,status,created_by) VALUES($1,'orthodontics','SYN ortho bridge',$2,'active','SYN') RETURNING id", [patientId, ortho])).rows[0].id);
  const bridged = await read("owner", patientId); expect(bridged.cases).toHaveLength(2); expect(bridged.cases.find(c => c.orthoCaseId === ortho)).toMatchObject({ id: bridge, kind: "specialty", status: "closed" });
  await fx.pool.query("UPDATE plan_items SET case_id=$1 WHERE id=$2", [bridge, saved.item]);
  await fx.pool.query("UPDATE patient_problems SET case_id=$1 WHERE id=$2", [bridge, saved.problemId]);
  const hidden = await read("all", patientId); expect(hidden.cases).toHaveLength(1); expect(hidden.items.find(i => i.id === saved.item)?.caseId).toBeNull(); expect(hidden.problems[0].caseId).toBeNull();
  expect(JSON.stringify(hidden)).not.toMatch(/SYN ortho bridge|SYN private ortho outcome/);
  await fx.setGrants("all", { ...VIEW, "clinical.ortho.view": true }, { patientScope: "all" });
  try { expect((await read("all", patientId)).cases).toHaveLength(2); } finally { await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it.each(["native-plan", "foreign-bridge"])("refuses a corrupt %s association before exposing any ortho details", async kind => {
  const patientId = await patient(`ortho-corrupt-${kind}`);
  const ortho = Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [patientId])).rows[0].id);
  if (kind === "native-plan") await fx.pool.query("UPDATE ortho_cases SET plan_id=$1 WHERE id=$2", [ids.plan, ortho]);
  else await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN foreign bridge',$2,'SYN')", [ids.outside, ortho]);
  await expect(read("owner", patientId)).rejects.toMatchObject({ code: "case_reference_unavailable" });
  expect((await read("all", patientId)).cases).toHaveLength(0);
});
it("the database rejects an invalid case state without altering the clinical record", async () => {
  const before = await read("own");
  await expect(fx.pool.query("UPDATE clinical_cases SET status='SYN-invalid' WHERE id=$1", [ids.caseId])).rejects.toMatchObject({ code: "23514", constraint: "clinical_cases_status_check" });
  expect(await read("own")).toEqual(before);
});
it.each(["item", "plan", "ortho"])("refuses unknown stored %s states without rewriting them", async kind => {
  const patientId = await patient(`invalid-${kind}`), saved = await seedCanonicalPatientCases(fx.pool, patientId);
  if (kind === "item") await fx.pool.query("UPDATE plan_items SET status='SYN-invalid' WHERE id=$1", [saved.item]);
  if (kind === "plan") await fx.pool.query("UPDATE treatment_plans SET status='SYN-invalid' WHERE id=$1", [saved.plan]);
  if (kind === "ortho") await fx.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'SYN-invalid','SYN')", [patientId]);
  await expect(read("owner", patientId)).rejects.toMatchObject({ code: "case_stored_data_invalid" });
});
it.each(["cases", "problems", "items", "dependencies", "bytes"])("refuses excessive %s without a misleading partial graph", async group => {
  const id = await patient(`limit-${group}`), saved = await seedCanonicalPatientCases(fx.pool, id);
  if (group === "cases") await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) SELECT $1,'general','SYN case','SYN' FROM generate_series(1,1000)", [id]);
  if (group === "problems") await fx.pool.query("INSERT INTO patient_problems(patient_id,label,noted_by) SELECT $1,'SYN problem','SYN' FROM generate_series(1,1000)", [id]);
  if (group === "items") await fx.pool.query("INSERT INTO plan_items(plan_id,service_name) SELECT $1,'SYN item' FROM generate_series(1,2000)", [saved.plan]);
  if (group === "dependencies") {
    const added = (await fx.pool.query("INSERT INTO plan_items(plan_id,service_name) SELECT $1,'SYN graph item' FROM generate_series(1,100) RETURNING id", [saved.plan])).rows.map(r => r.id);
    await fx.pool.query("INSERT INTO plan_item_dependencies(item_id,requires_item_id,requirement,created_by) SELECT a,b,'completed','SYN' FROM unnest($1::int[]) a CROSS JOIN unnest($1::int[]) b WHERE a>b LIMIT 4000", [added]);
  }
  if (group === "bytes") await fx.pool.query("UPDATE clinical_cases SET problem=repeat('x',2100000) WHERE id=$1", [saved.caseId]);
  await expect(read("owner", id)).rejects.toMatchObject({ code: "case_read_limit" });
});
it("returns a legitimate empty file distinctly from a refused read", async () => {
  expect(await read("owner", await patient("empty"))).toMatchObject({ cases: [], problems: [], items: [], dependencies: [], planVisible: true });
});
it("retains cancelled-plan endpoints and evaluates clearance from recorded clinical status", async () => {
  await fx.pool.query("UPDATE treatment_plans SET status='cancelled' WHERE id=$1", [ids.plan]);
  await fx.pool.query("UPDATE plan_items SET status='in_progress' WHERE id=$1", [ids.prerequisite]);
  await fx.pool.query("UPDATE plan_item_dependencies SET requirement='clearance' WHERE item_id=$1", [ids.item]);
  try { const result = await read("own"); expect(result.items).toHaveLength(2); expect(result.items.every(i => i.planStatus === "cancelled")).toBe(true); expect(result.dependencies[0].met).toBe(true); }
  finally { await fx.pool.query("UPDATE treatment_plans SET status='active' WHERE id=$1", [ids.plan]); await fx.pool.query("UPDATE plan_items SET status='done' WHERE id=$1", [ids.prerequisite]); await fx.pool.query("UPDATE plan_item_dependencies SET requirement='completed' WHERE item_id=$1", [ids.item]); }
});
it("refuses an existing cycle rather than pretending it is a schedulable graph", async () => {
  await fx.pool.query("INSERT INTO plan_item_dependencies(item_id,requires_item_id,requirement,created_by) VALUES($1,$2,'completed','SYN')", [ids.prerequisite, ids.item]);
  try { await expect(read("own")).rejects.toMatchObject({ code: "case_stored_data_invalid" }); }
  finally { await fx.pool.query("DELETE FROM plan_item_dependencies WHERE item_id=$1 AND requires_item_id=$2", [ids.prerequisite, ids.item]); }
});
function intercept(wrap: (q: CanonicalSnapshotQuery) => CanonicalSnapshotQuery) {
  const original = snapshots.runCanonicalReadSnapshot;
  return vi.spyOn(snapshots, "runCanonicalReadSnapshot").mockImplementationOnce((session, key, reader, options) => original(session, key, (q, scope) => reader(wrap(q), scope), options));
}
it("uses one RR READ ONLY lease without financial tables, DDL, pool escape or writes", async () => {
  const sql = "SELECT (SELECT count(*) FROM audit_log)::int audit,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM clinical_cases c) cases";
  const before = (await fx.pool.query(sql)).rows, session = await fx.session("owner"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  const hook = intercept(q => ({ query: (async (text: string, args?: unknown[]) => {
    expect(text).not.toMatch(/\b(payments|invoices|plan_installments|legacy_treatment_agreements|approved_agreement_principals)\b/);
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on"); return q.query(text, args);
  }) as typeof q.query }));
  try { await reads.readCanonicalPatientCases(session, ids.patient); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { hook.mockRestore(); connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect((await fx.pool.query(sql)).rows).toEqual(before);
});
it("case text, dependency status and patient scope remain in one snapshot across a concurrent commit", async () => {
  let changed = false;
  const hook = intercept(q => ({ query: (async (text: string, args?: unknown[]) => {
    const result = await q.query(text, args);
    if (!changed && text.startsWith("SELECT count(*)::text n FROM")) {
      changed = true; const writer = await side.connect();
      try { await writer.query("BEGIN"); await writer.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.patient]);
        await writer.query("UPDATE clinical_cases SET title='SYN changed case',responsible_party_id=NULL WHERE id=$1", [ids.caseId]);
        await writer.query("UPDATE plan_items SET doctor_id=NULL WHERE id=$1", [ids.item]);
        await writer.query("UPDATE plan_items SET status='planned' WHERE id=$1", [ids.prerequisite]); await writer.query("COMMIT");
      } finally { await writer.query("ROLLBACK"); writer.release(); }
    }
    return result;
  }) as typeof q.query }));
  try { const result = await read("own"); expect(result.cases[0].title).toBe("SYN root case"); expect(result.dependencies[0].met).toBe(true);
    hook.mockRestore(); await expect(read("own")).rejects.toMatchObject({ code: "patient_not_found" }); expect((await read("all")).dependencies[0].met).toBe(false);
  } finally { hook.mockRestore(); await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.patient]); await side.query("UPDATE clinical_cases SET title='SYN root case',responsible_party_id=$2 WHERE id=$1", [ids.caseId, fx.parties.own]); await side.query("UPDATE plan_items SET status='done' WHERE id=$1", [ids.prerequisite]); await side.query("UPDATE plan_items SET doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.item]); }
});
it("expires during a proven lifecycle lock wait", async () => {
  const session = await fx.session("own", 1500), holder = await side.connect();
  try { await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalPatientCases(session, ids.patient); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); }
    finally { await holder.query("COMMIT"); } await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("rechecks revocation after waiting on the authority fence", async () => {
  const stale = await fx.session("all"), holder = await side.connect();
  try { await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 2)), fx.ids.all]);
    const pending = reads.readCanonicalPatientCases(stale, ids.patient); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/); await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("revoked patient scope and retired credentials invalidate earlier sessions", async () => {
  const stale = await fx.session("own"); await fx.setGrants("own", VIEW, { patientScope: "none" });
  try { await expect(reads.readCanonicalPatientCases(stale, ids.patient)).rejects.toThrow(/STALE/); await expect(read("own")).rejects.toThrow(/RECORD_SCOPE_DENIED/); }
  finally { await fx.setGrants("own", VIEW, { patientScope: "own" }); }
  const old = await fx.session("own"); await fx.pool.query("UPDATE users SET password_hash='SYN retired case hash' WHERE id=$1", [fx.ids.own]);
  await expect(reads.readCanonicalPatientCases(old, ids.patient)).rejects.toThrow(/STALE/); expect((await read("own")).cases).toHaveLength(1);
});
it("an intermediate SQL failure publishes no partial result and discards its lease", async () => {
  const hook = intercept(q => ({ query: (async (text: string, args?: unknown[]) => text.includes('AS "requiredStatus"') ? q.query("SELECT 1/0") : q.query(text, args)) as typeof q.query }));
  try { await expect(read("own")).rejects.toThrow(); } finally { hook.mockRestore(); }
  expect((await read("own")).cases).toHaveLength(1);
});
