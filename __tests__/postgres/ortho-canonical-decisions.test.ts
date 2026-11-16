import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-ortho-decisions-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ortho-decisions");
const VIEW = { "clinical.ortho.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-OD-OWNER", role: "admin" },
  own: { username: "SYN-OD-OWN", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "none", grants: VIEW },
  all: { username: "SYN-OD-ALL", role: "reception", patientScope: "all", grants: VIEW },
  none: { username: "SYN-OD-NONE", role: "doctor", doctor: true, patientScope: "none", appointmentScope: "all", grants: VIEW },
  unlinked: { username: "SYN-OD-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
  adjacent: { username: "SYN-OD-ADJACENT", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { patient: 0, outside: 0, caseId: 0, outsideCase: 0, review: 0, outsideContract: 0, foreign: 0 };
const read = async (key: Key) => reads.readCanonicalOrthoDecisions(await fx.session(key));
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  for (const key of ["patient", "outside"] as const) { ids[key] = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$1,'SYN private phone',$2) RETURNING id", [`SYN-OD-${key}`, key === "patient" ? fx.parties.own : null])).rows[0].id;
    const id = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by,note) VALUES($1,'SYN','SYN private care note') RETURNING id", [ids[key]])).rows[0].id; if (key === "patient") ids.caseId = id; else ids.outsideCase = id; }
  for (const [key, c, kind] of [["review", ids.caseId, "REVIEW_REQUIRED"], ["outsideContract", ids.caseId, "OUTSIDE_CONTRACT"], ["foreign", ids.outsideCase, "REVIEW_REQUIRED"]] as const) ids[key] = (await fx.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by,billing_class,note) VALUES($1,'2026-10-01','SYN',$2,'SYN private adjustment') RETURNING id", [c, kind])).rows[0].id;
  await fx.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by,billing_class) VALUES($1,'2026-10-01','SYN','LEGACY_INCLUDED')", [ids.caseId]);
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it("own patient summary exposes only saved pending-review identity and date, without independent visit/financial facts", async () => {
  const feed = await read("own"); expect(feed.pending.map(r => r.adjustmentId)).toEqual([ids.review, ids.outsideContract]); expect(feed).toMatchObject({ projection: "ortho-pending-decisions", limit: 300, hasMore: false });
  expect(Object.keys(feed.pending[0]).sort()).toEqual(["adjustmentId", "decisionContext", "doctorName", "doneOn", "legacy", "patientId", "patientName"]); expect(feed.pending[0].legacy).toBe(false);
  expect(JSON.stringify(feed)).not.toMatch(/private|visitId|invoice|currency|Minor|planId|billing_class|source|recorded_by|wire|note/);
});
it.each(["none", "unlinked", "adjacent"] as const)("%s cannot infer access from a role or appointment scope", async key => { await expect(read(key)).rejects.toThrow(/CAPABILITY|SCOPE|PROVIDER/); });
it("all/owner retain the admitted list and legacy source selection remains unchanged", async () => {
  for (const key of ["all", "owner"] as const) expect((await read(key)).pending.map(r => r.adjustmentId)).toEqual([ids.review, ids.outsideContract, ids.foreign]);
  const old = await db.listPendingOrthoDecisions(), feed = await read("owner"); expect(feed.pending.map(({ decisionContext: _decisionContext, ...row }) => row)).toEqual(old.map(({ visitId: _visitId, ...row }) => row));
});
it("hidden care and financial facts cannot expand the response; closed cases retain their recorded pending review", async () => {
  const before = await read("own"); await fx.pool.query("UPDATE ortho_adjustments SET note='SYN changed private note' WHERE id=$1", [ids.review]); await fx.pool.query("UPDATE ortho_cases SET note='SYN changed private care',status='completed' WHERE id=$1", [ids.caseId]);
  try { expect(await read("own")).toEqual(before); } finally { await fx.pool.query("UPDATE ortho_cases SET status='active' WHERE id=$1", [ids.caseId]); }
});
it("one RR connection observes a coherent pending decision across a concurrent resolution", async () => {
  const session = await fx.session("own"), original = db.listPendingOrthoDecisionSummariesWith, pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  const spy = vi.spyOn(db, "listPendingOrthoDecisionSummariesWith").mockImplementationOnce(async (q, doctor) => { expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read"); expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on"); await side.query("UPDATE ortho_adjustments SET billing_decision='no_charge' WHERE id=$1", [ids.review]); return original(q, doctor); });
  try { expect((await reads.readCanonicalOrthoDecisions(session)).pending.map(r => r.adjustmentId)).toContain(ids.review); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { spy.mockRestore(); connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  try { expect((await read("own")).pending.map(r => r.adjustmentId)).not.toContain(ids.review); } finally { await fx.pool.query("UPDATE ortho_adjustments SET billing_decision=NULL WHERE id=$1", [ids.review]); }
});
it("membership is stable within the snapshot and removed from the next request", async () => {
  const original = db.listPendingOrthoDecisionSummariesWith, spy = vi.spyOn(db, "listPendingOrthoDecisionSummariesWith").mockImplementationOnce(async (q, doctor) => { await side.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.patient]); return original(q, doctor); });
  try { expect((await read("own")).pending).toHaveLength(2); spy.mockRestore(); expect((await read("own")).pending).toEqual([]); }
  finally { spy.mockRestore(); await fx.pool.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.patient]); }
});
it("a saved foreign visit reference refuses without exposing its clinician or repairing it", async () => {
  const visit = (await fx.pool.query("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'SYN foreign visit',$2) RETURNING id", [ids.outside, fx.parties.none])).rows[0].id;
  await fx.pool.query("UPDATE ortho_adjustments SET visit_id=$1 WHERE id=$2", [visit, ids.review]);
  try { await expect(read("owner")).rejects.toThrow("STAFF_READ_READ_FAILED"); expect((await fx.pool.query("SELECT visit_id FROM ortho_adjustments WHERE id=$1", [ids.review])).rows[0].visit_id).toBe(visit); }
  finally { await fx.pool.query("UPDATE ortho_adjustments SET visit_id=NULL WHERE id=$1", [ids.review]); }
});
it("invalid clinician linkage refuses while the known responsible doctor remains a summary field", async () => {
  const party = (await fx.pool.query("INSERT INTO parties(kind,name) VALUES('supplier','SYN hidden vendor') RETURNING id")).rows[0].id;
  await fx.pool.query("UPDATE ortho_cases SET responsible_doctor_id=$1 WHERE id=$2", [party, ids.caseId]);
  try { await expect(read("owner")).rejects.toThrow("STAFF_READ_READ_FAILED"); } finally { await fx.pool.query("UPDATE ortho_cases SET responsible_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.caseId]); }
  try { expect((await read("own")).pending[0].doctorName).toBeTruthy(); } finally { await fx.pool.query("UPDATE ortho_cases SET responsible_doctor_id=NULL WHERE id=$1", [ids.caseId]); }
});
it("stale credentials and withdrawn scope do not return a cached queue", async () => {
  const old = await fx.session("all"); await fx.setGrants("all", VIEW, { patientScope: "none" });
  try { await expect(reads.readCanonicalOrthoDecisions(old)).rejects.toThrow(/STALE/); await expect(read("all")).rejects.toThrow(/SCOPE/); } finally { await fx.setGrants("all", VIEW, { patientScope: "all" }); }
  const signed = await fx.session("all"); await fx.pool.query("UPDATE users SET password_hash='SYN retired decision hash' WHERE id=$1", [fx.ids.all]); await expect(reads.readCanonicalOrthoDecisions(signed)).rejects.toThrow(/STALE|SESSION/);
});
it("withdrawal committed behind the actual lifecycle fence is checked before reading", async () => {
  const session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))"); pending = reads.readCanonicalOrthoDecisions(session); void pending.catch(() => undefined); await waitForBlockedBy(side, pid); await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 5)), fx.ids.all]); await gate.query("COMMIT"); await expect(pending).rejects.toThrow(/STALE/); }
  finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("oversized name context refuses the whole response without a misleading empty list", async () => {
  const old = (await fx.pool.query("SELECT full_name FROM patients WHERE id=$1", [ids.patient])).rows[0].full_name;
  // Many individually valid indexed names exceed the aggregate boundary; no
  // index/constraint is removed merely to manufacture an oversized row.
  const extras = (await fx.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by,billing_class) SELECT $1,'2026-10-03','SYN','REVIEW_REQUIRED' FROM generate_series(1,299) RETURNING id", [ids.caseId])).rows.map(r => r.id);
  await fx.pool.query("UPDATE patients SET full_name=repeat('ع',2000) WHERE id=$1", [ids.patient]);
  try { await expect(read("own")).rejects.toThrow("STAFF_READ_READ_FAILED"); }
  finally { await fx.pool.query("UPDATE patients SET full_name=$1 WHERE id=$2", [old, ids.patient]); await fx.pool.query("DELETE FROM ortho_adjustments WHERE id=ANY($1::int[])", [extras]); }
});

it("scope precedes the oldest-300 bound and hasMore describes only admitted rows", async () => {
  await fx.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by,billing_class) SELECT $1,'2000-01-01','SYN','REVIEW_REQUIRED' FROM generate_series(1,301)", [ids.outsideCase]); expect((await read("own")).pending.map(r => r.adjustmentId)).toEqual([ids.review, ids.outsideContract]);
  await fx.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by,billing_class) SELECT $1,'2026-10-02','SYN','REVIEW_REQUIRED' FROM generate_series(1,299)", [ids.caseId]); const result = await read("own"); expect(result.pending).toHaveLength(300); expect(result.hasMore).toBe(true); expect(result.pending.every(r => r.patientId === ids.patient)).toBe(true);
});
