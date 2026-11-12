import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalClinicalPlan } from "../fixtures/canonical-clinical-plans";
import type { CanonicalSnapshotQuery } from "../../lib/canonical-read-snapshot";

vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-clinical-plan-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-plan-reads"), snapshots = await import("../../lib/canonical-read-snapshot");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const VIEW = { "clinical.plans.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PC-OWNER", role: "admin" },
  own: { username: "SYN-PC-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-PC-ALL", role: "reception", patientScope: "all", grants: VIEW },
  none: { username: "SYN-PC-NONE", role: "doctor", doctor: true, patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-PC-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
  adjacent: { username: "SYN-PC-ADJACENT", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true, "finance.patient-ledger.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { own: 0, outside: 0, plan: 0, item: 0 };
const read = async (key: Key, patientId = ids.own) => reads.readCanonicalClinicalPlans(await fx.session(key), patientId);
async function patient(label: string) {
  return (await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$1) RETURNING id", [`SYN-PC-${label}`])).rows[0].id as number;
}
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  ids.own = await patient("own"); ids.outside = await patient("outside");
  await fx.pool.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.own]);
  Object.assign(ids, await seedCanonicalClinicalPlan(fx.pool, ids.own, fx.parties.own));
  await seedCanonicalClinicalPlan(fx.pool, ids.outside);
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it("registers exactly the plan grant plus patient scope", () => {
  expect(CANONICAL_RECORD_READS["read:plans.clinical"]).toEqual({ record: "patient", need: ["clinical.plans.view"], anyOf: [] });
});
it.each(["owner", "own", "all"] as const)("%s reads recorded clinical facts, actual completed sessions and no money", async key => {
  const result = await read(key);
  expect(Object.keys(result).sort()).toEqual(["clinicTimeZone", "hasMore", "patientId", "plans", "projection"]);
  expect(Object.keys(result.plans[0]).sort()).toEqual(["consentAt", "consentBy", "consentNote", "createdAt", "id", "items", "note", "startDate", "status", "title"]);
  expect(result.plans[0]).toMatchObject({ id: ids.plan, title: "SYN clinical treatment plan", note: "SYN saved clinical note", consentBy: "SYN recorder", startDate: "2024-03-01" });
  expect(result.plans[0].items[0]).toMatchObject({ id: ids.item, serviceName: "SYN recorded service", quantity: 2, toothCode: 26, sessionCount: 3, sessionsCompleted: 1, plannedVisitNumber: 2 });
  expect(JSON.stringify(result)).not.toMatch(/9900123|price|Minor|currency|installment|invoice|payment|billing|patientName|patientPhone|financial/i);
});
it.each(["none", "unlinked", "adjacent"] as const)("denies %s without translating a role or neighboring grant", async key => {
  await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);
});
it("foreign and missing patients are indistinguishable", async () => {
  const errors = [];
  for (const id of [ids.outside, 2147483647]) {
    try { await read("own", id); throw new Error("unexpected success"); }
    catch (error) { errors.push({ code: (error as { code: string }).code, message: (error as Error).message }); }
  }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("patient_not_found");
});
it("the financial values and malformed currency do not affect the clinical projection", async () => {
  const before = await read("own");
  await fx.pool.query("UPDATE treatment_plans SET total_minor=88881234,base_currency='SYN-INVALID' WHERE id=$1", [ids.plan]);
  await fx.pool.query("UPDATE plan_items SET unit_price_minor=77771234,billing_status='needs_financial_review' WHERE id=$1", [ids.item]);
  try { expect(await read("own")).toEqual(before); }
  finally {
    await fx.pool.query("UPDATE treatment_plans SET total_minor=9900123,base_currency='YER' WHERE id=$1", [ids.plan]);
    await fx.pool.query("UPDATE plan_items SET unit_price_minor=9900123,billing_status='unbilled' WHERE id=$1", [ids.item]);
  }
});
it("returns latest 100 with hasMore and does not load omitted plans", async () => {
  const id = await patient("limit");
  await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_at) SELECT $1,'SYN plan '||n,1,'2024-01-01'::timestamptz+n*interval '1 hour' FROM generate_series(1,101) n", [id]);
  const result = await read("owner", id);
  expect(result.hasMore).toBe(true); expect(result.plans).toHaveLength(100); expect(result.plans[0].title).toBe("SYN plan 101");
  expect(result.plans.at(-1)?.title).toBe("SYN plan 2");
});
it("legitimate emptiness and recorded zero targets are not fabricated progress", async () => {
  expect(await read("owner", await patient("empty"))).toMatchObject({ plans: [], hasMore: false });
  const old = (await fx.pool.query("SELECT session_count,planned_visit_number FROM plan_items WHERE id=$1", [ids.item])).rows[0];
  await fx.pool.query("UPDATE plan_items SET session_count=0,planned_visit_number=0 WHERE id=$1", [ids.item]);
  try { expect((await read("own")).plans[0].items[0]).toMatchObject({ sessionCount: 0, plannedVisitNumber: 0, sessionsCompleted: 1 }); }
  finally { await fx.pool.query("UPDATE plan_items SET session_count=$1,planned_visit_number=$2 WHERE id=$3", [old.session_count, old.planned_visit_number, ids.item]); }
});
it.each(["items", "bytes"])("refuses excessive %s without silent truncation", async kind => {
  const id = await patient(`large-${kind}`), saved = await seedCanonicalClinicalPlan(fx.pool, id);
  if (kind === "items") await fx.pool.query("INSERT INTO plan_items(plan_id,service_name) SELECT $1,'SYN item '||n FROM generate_series(1,256) n", [saved.plan]);
  else await fx.pool.query("UPDATE treatment_plans SET note=repeat('x',2100000) WHERE id=$1", [saved.plan]);
  await expect(read("owner", id)).rejects.toMatchObject({ code: "plan_read_limit" });
});
it("refuses an unknown historical state without rewriting it", async () => {
  await fx.pool.query("UPDATE plan_items SET status='SYN-unknown' WHERE id=$1", [ids.item]);
  try { await expect(read("owner")).rejects.toMatchObject({ code: "plan_stored_data_invalid" }); expect((await fx.pool.query("SELECT status FROM plan_items WHERE id=$1", [ids.item])).rows[0].status).toBe("SYN-unknown"); }
  finally { await fx.pool.query("UPDATE plan_items SET status='planned' WHERE id=$1", [ids.item]); }
});
it("bounds total items across plans even when every individual plan is below its limit", async () => {
  const id = await patient("total-items");
  const plans = (await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor) SELECT $1,'SYN bounded plan',1 FROM generate_series(1,10) RETURNING id", [id])).rows.map(row => row.id);
  await fx.pool.query("INSERT INTO plan_items(plan_id,service_name) SELECT id,'SYN bounded item' FROM unnest($1::int[]) id CROSS JOIN generate_series(1,201)", [plans]);
  await expect(read("owner", id)).rejects.toMatchObject({ code: "plan_read_limit" });
});
it.each(["item", "session"])("refuses a foreign visit referenced by the %s", async kind => {
  const visit = (await fx.pool.query("INSERT INTO visits(patient_name,patient_id) VALUES('SYN private foreign visit',$1) RETURNING id", [ids.outside])).rows[0].id;
  if (kind === "item") await fx.pool.query("UPDATE plan_items SET visit_id=$1 WHERE id=$2", [visit, ids.item]);
  else await fx.pool.query("UPDATE treatment_sessions SET visit_id=$1 WHERE plan_item_id=$2 AND sequence=1", [visit, ids.item]);
  try { await expect(read("owner")).rejects.toMatchObject({ code: "plan_reference_unavailable" }); }
  finally {
    await fx.pool.query("UPDATE plan_items SET visit_id=NULL WHERE id=$1", [ids.item]);
    await fx.pool.query("UPDATE treatment_sessions SET visit_id=NULL WHERE plan_item_id=$1", [ids.item]);
  }
});
it("foreign clinical case references reject the whole result", async () => {
  const foreign = (await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,site,status,created_by) VALUES($1,'general','SYN foreign case','SYN private site','active','SYN') RETURNING id", [ids.outside])).rows[0].id;
  await fx.pool.query("UPDATE plan_items SET case_id=$1 WHERE id=$2", [foreign, ids.item]);
  try { await expect(read("owner")).rejects.toMatchObject({ code: "plan_reference_unavailable" }); }
  finally { await fx.pool.query("UPDATE plan_items SET case_id=NULL WHERE id=$1", [ids.item]); }
});
it("a foreign planned visit is not counted as this patient's completed work", async () => {
  const foreign = (await fx.pool.query("INSERT INTO planned_visits(patient_id,sequence,title) VALUES($1,1,'SYN foreign visit') RETURNING id", [ids.outside])).rows[0].id;
  await fx.pool.query("UPDATE treatment_sessions SET planned_visit_id=$1 WHERE plan_item_id=$2 AND sequence=1", [foreign, ids.item]);
  try { await expect(read("owner")).rejects.toMatchObject({ code: "plan_reference_unavailable" }); }
  finally { await fx.pool.query("UPDATE treatment_sessions SET planned_visit_id=NULL WHERE plan_item_id=$1", [ids.item]); }
});
function intercept(wrap: (q: CanonicalSnapshotQuery) => CanonicalSnapshotQuery) {
  const original = snapshots.runCanonicalReadSnapshot;
  return vi.spyOn(snapshots, "runCanonicalReadSnapshot").mockImplementationOnce((session, key, reader, options) => original(session, key, (q, scope) => reader(wrap(q), scope), options));
}
it("one RR READ ONLY lease, no financial table reads, no initialization and no side effects", async () => {
  const sql = "SELECT (SELECT count(*) FROM audit_log)::int audit,(SELECT count(*) FROM invoices)::int invoices,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p) plans";
  const before = (await fx.pool.query(sql)).rows, session = await fx.session("own"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  const hook = intercept(q => ({ query: (async (text: string, args?: unknown[]) => {
    expect(text).not.toMatch(/\b(payments|plan_installments|invoices|approved_agreement_principals)\b/);
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on"); return q.query(text, args);
  }) as typeof q.query }));
  try { await reads.readCanonicalClinicalPlans(session, ids.own); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { hook.mockRestore(); connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect((await fx.pool.query(sql)).rows).toEqual(before);
});
it("scope, plan note and session progress stay in one snapshot across a concurrent commit", async () => {
  let changed = false;
  const hook = intercept(q => ({ query: (async (text: string, args?: unknown[]) => {
    const result = await q.query(text, args);
    if (!changed && text.startsWith("SELECT id FROM treatment_plans")) {
      changed = true; const writer = await side.connect();
      try { await writer.query("BEGIN"); await writer.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.own]);
        await writer.query("UPDATE treatment_plans SET note='SYN new note' WHERE id=$1", [ids.plan]);
        await writer.query("UPDATE treatment_sessions SET status='done' WHERE plan_item_id=$1", [ids.item]); await writer.query("COMMIT");
      } finally { await writer.query("ROLLBACK"); writer.release(); }
    }
    return result;
  }) as typeof q.query }));
  try {
    const value = await read("own"); expect(value.plans[0].note).toBe("SYN saved clinical note"); expect(value.plans[0].items[0].sessionsCompleted).toBe(1);
    hook.mockRestore(); await expect(read("own")).rejects.toMatchObject({ code: "patient_not_found" }); expect((await read("all")).plans[0].items[0].sessionsCompleted).toBe(2);
  } finally { hook.mockRestore(); await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.own]);
    await side.query("UPDATE treatment_plans SET note='SYN saved clinical note' WHERE id=$1", [ids.plan]); await side.query("UPDATE treatment_sessions SET status='planned' WHERE plan_item_id=$1 AND sequence=2", [ids.item]); }
});
it("expires during an observed lifecycle lock wait", async () => {
  const session = await fx.session("own", 1500), holder = await side.connect();
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalClinicalPlans(session, ids.own); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("rechecks capability revocation after waiting and rejects a fresh session without the grant", async () => {
  const stale = await fx.session("all"), holder = await side.connect();
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 2)), fx.ids.all]);
    const pending = reads.readCanonicalClinicalPlans(stale, ids.own); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/); await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("scope revocation and credential retirement invalidate prior authority", async () => {
  const stale = await fx.session("own"); await fx.setGrants("own", VIEW, { patientScope: "none" });
  try { await expect(reads.readCanonicalClinicalPlans(stale, ids.own)).rejects.toThrow(/STALE/); await expect(read("own")).rejects.toThrow(/RECORD_SCOPE_DENIED/); }
  finally { await fx.setGrants("own", VIEW, { patientScope: "own" }); }
  const old = await fx.session("own"); await fx.pool.query("UPDATE users SET password_hash='SYN retired plan hash' WHERE id=$1", [fx.ids.own]);
  await expect(reads.readCanonicalClinicalPlans(old, ids.own)).rejects.toThrow(/STALE/); expect((await read("own")).plans).toHaveLength(1);
});
it("a query failure returns no partial plan and the next lease remains usable", async () => {
  const hook = intercept(q => ({ query: (async (text: string, args?: unknown[]) => text.includes("AS sessions_completed") ? q.query("SELECT 1/0") : q.query(text, args)) as typeof q.query }));
  try { await expect(read("own")).rejects.toThrow(); } finally { hook.mockRestore(); }
  expect((await read("own")).plans).toHaveLength(1);
});
