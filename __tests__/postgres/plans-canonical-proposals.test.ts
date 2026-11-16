import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy, capabilityDocument } from "./_canonical-ready-fixture";
vi.mock("server-only", () => ({}));
assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-proposal-secret-0123456789abcdef");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-proposals");
const GRANTS = { "clinical.plans.edit": true, "clinical.plans.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PROP-OWNER", role: "admin" },
  own: { username: "SYN-PROP-OWN", role: "doctor", doctor: true, patientScope: "own", grants: GRANTS },
  all: { username: "SYN-PROP-ALL", role: "reception", patientScope: "all", grants: GRANTS },
  money: { username: "SYN-PROP-MONEY", role: "reception", patientScope: "all", grants: { ...GRANTS, "finance.patient-ledger.view": true } },
  viewer: { username: "SYN-PROP-VIEWER", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "SYN-PROP-NONE", role: "doctor", doctor: true, patientScope: "none", grants: GRANTS },
  unlinked: { username: "SYN-PROP-UNLINKED", role: "doctor", patientScope: "own", grants: GRANTS },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { patient: 0, outside: 0, ownPlan: 0, foreignPlan: 0 };
const read = async (key: Key) => reads.readCanonicalProposals(await fx.session(key));
async function plan(patientId: number, title = "SYN proposal", status = "active", consent = false) {
  return (await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,status,consent_at,created_at,note) VALUES($1,$2,123456,'SAR',$3,CASE WHEN $4 THEN NOW() END,'2026-10-01 09:00+03','SYN private care note') RETURNING id", [patientId, title, status, consent])).rows[0].id as number;
}
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  for (const [key, party] of [["patient", fx.parties.own!], ["outside", null]] as const) ids[key] = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$1,'SYN phone',$2) RETURNING id", [`SYN-PROP-${key}`, party])).rows[0].id;
  ids.ownPlan = await plan(ids.patient); ids.foreignPlan = await plan(ids.outside, "SYN outside title");
  await plan(ids.patient, "SYN consented", "active", true); await plan(ids.patient, "SYN cancelled", "cancelled");
  await fx.pool.query("INSERT INTO plan_items(plan_id,service_name,status) VALUES($1,'SYN hidden service','planned'),($1,'SYN cancelled item','cancelled')", [ids.ownPlan]);
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it("own scope sees only active unconsented proposals with an explicit minimal projection", async () => {
  const feed = await read("own"); expect(feed.proposals.map(r => r.planId)).toEqual([ids.ownPlan]);
  expect(feed).toMatchObject({ projection: "pending-plan-proposals", canSeeMoney: false, followUpDays: 7, limit: 300, hasMore: false, proposals: [{ patientId: ids.patient, title: "SYN proposal", items: 1, lastContactOn: null }] });
  expect(JSON.stringify(feed)).not.toMatch(/123456|SAR|totalMinor|currency|private care|hidden service|consented|cancelled item|outside|whatsapp|planXmin|planTid|contactId/);
});
it.each(["viewer", "none", "unlinked"] as const)("denies %s without role expansion", async key => { await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/); });
it("all scope is separate from the independent money projection; owner retains it", async () => {
  expect((await read("all")).proposals.map(r => r.planId)).toEqual([ids.ownPlan, ids.foreignPlan]);
  for (const key of ["money", "owner"] as const) expect((await read(key)).proposals.find(r => r.planId === ids.ownPlan)?.money).toEqual({ totalMinor: 123456, currency: "SAR" });
});
it("legacy selection and classification facts remain identical for their permitted fields", async () => {
  const legacy = await db.listPendingProposals({ includeMoney: true }), canonical = await read("owner");
  for (const old of legacy) expect(canonical.proposals.find(r => r.planId === old.planId)).toMatchObject({ patientId: old.patientId, patientName: old.patientName, title: old.title, createdOn: old.createdOn, lastContactOn: old.lastContactOn, items: old.items, money: { totalMinor: old.totalMinor, currency: old.currency } });
});
it("reads only proposal-contact audit timing, never installment reminder notes", async () => {
  const before = (await read("own")).proposals[0];
  await fx.pool.query("INSERT INTO audit_log(action,entity,entity_id,summary,actor,created_at) VALUES('plan.installment_reminder','treatment_plans',$1,'SYN other reminder','SYN',NOW())", [String(ids.ownPlan)]);
  expect((await read("own")).proposals[0].contactVersion).toBe(before.contactVersion);
  await fx.pool.query("INSERT INTO audit_log(action,entity,entity_id,summary,actor,created_at) VALUES('plan.proposal_contact','treatment_plans',$1,'SYN private contact note','SYN',NOW())", [String(ids.ownPlan)]);
  const after = (await read("own")).proposals[0]; expect(after.timing).toMatchObject({ stage: "contacted", daysSinceContact: 0 }); expect(after.contactVersion).not.toBe(before.contactVersion);
  expect(JSON.stringify(after)).not.toContain("private contact note");
});
it("settings are validated through the existing fallback without changing stored values", async () => {
  const old = (await fx.pool.query("SELECT value FROM settings WHERE key='followup.proposal_days'")).rows[0]?.value;
  try {
    for (const [value, expected] of [["3", 3], ["0", 7], ["91", 7], ["invalid", 7]] as const) {
      await fx.pool.query("INSERT INTO settings(key,value) VALUES('followup.proposal_days',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [value]); expect((await read("owner")).followUpDays).toBe(expected);
      expect((await fx.pool.query("SELECT value FROM settings WHERE key='followup.proposal_days'")).rows[0].value).toBe(value);
    }
  } finally { if (old === undefined) await fx.pool.query("DELETE FROM settings WHERE key='followup.proposal_days'"); else await fx.pool.query("UPDATE settings SET value=$1 WHERE key='followup.proposal_days'", [old]); }
});
it("one RR lease keeps scope, settings, selection and contact timing coherent", async () => {
  const session = await fx.session("own"), pool = db.getPool(), original = db.listPendingProposalSummariesWith;
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), initialize = vi.spyOn(db, "ensureSchema");
  const spy = vi.spyOn(db, "listPendingProposalSummariesWith").mockImplementationOnce(async (q, doctor, money) => {
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read"); expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    await side.query("UPDATE treatment_plans SET consent_at=NOW() WHERE id=$1", [ids.ownPlan]); return original(q, doctor, money);
  });
  try { expect((await reads.readCanonicalProposals(session)).proposals.some(r => r.planId === ids.ownPlan)).toBe(true); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled(); }
  finally { spy.mockRestore(); connect.mockRestore(); query.mockRestore(); initialize.mockRestore(); }
  try { expect((await read("own")).proposals.some(r => r.planId === ids.ownPlan)).toBe(false); } finally { await fx.pool.query("UPDATE treatment_plans SET consent_at=NULL WHERE id=$1", [ids.ownPlan]); }
});
it("membership changes remain snapshot-consistent and remove the following read's rows", async () => {
  const original = db.listPendingProposalSummariesWith;
  const spy = vi.spyOn(db, "listPendingProposalSummariesWith").mockImplementationOnce(async (q, doctor, money) => { await side.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.patient]); return original(q, doctor, money); });
  try { expect((await read("own")).proposals).toHaveLength(1); spy.mockRestore(); expect((await read("own")).proposals).toEqual([]); }
  finally { spy.mockRestore(); await fx.pool.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.patient]); }
});
it("scope none and credential retirement deny old sessions and do not expose a cached list", async () => {
  const stale = await fx.session("all"); await fx.setGrants("all", GRANTS, { patientScope: "none" });
  try { await expect(reads.readCanonicalProposals(stale)).rejects.toThrow(/STALE/); await expect(read("all")).rejects.toThrow(/RECORD_SCOPE_DENIED/); }
  finally { await fx.setGrants("all", GRANTS, { patientScope: "all" }); }
  const old = await fx.session("all"); await fx.pool.query("UPDATE users SET password_hash='SYN proposal retired hash' WHERE id=$1", [fx.ids.all]); await expect(reads.readCanonicalProposals(old)).rejects.toThrow(/STALE|SESSION/);
});
it("waits before its snapshot and rejects an authority change committed behind the fence", async () => {
  const session = await fx.session("all"), locker = await side.connect();
  try {
    await locker.query("BEGIN"); const pid = (await locker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await locker.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))");
    const pending = reads.readCanonicalProposals(session).then(v => ({v}), e => ({e})); await waitForBlockedBy(fx.pool, pid);
    await locker.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 50)), fx.ids.all]); await locker.query("COMMIT"); expect(await pending).toHaveProperty("e");
  } finally { await locker.query("ROLLBACK"); locker.release(); await fx.setGrants("all", GRANTS, { patientScope: "all" }); }
});
it("does not round unsafe visible money and does not disclose it without the money grant", async () => {
  const id = await plan(ids.patient, "SYN invalid money");
  try { await fx.pool.query("UPDATE treatment_plans SET total_minor=9007199254740993 WHERE id=$1", [id]); await expect(read("owner")).rejects.toThrow("STAFF_READ_READ_FAILED"); expect((await read("own")).proposals.some(r => r.planId === id)).toBe(true); }
  finally { await fx.pool.query("UPDATE treatment_plans SET status='cancelled' WHERE id=$1", [id]); }
});
it("bounded overlarge text refuses the whole list instead of truncating patient facts", async () => {
  const id = await plan(ids.patient, "x".repeat(1050000));
  try { await expect(read("own")).rejects.toThrow("STAFF_READ_READ_FAILED"); } finally { await fx.pool.query("UPDATE treatment_plans SET status='cancelled' WHERE id=$1", [id]); }
});
it("scope is applied before the 300-row bound and hasMore is explicit", async () => {
  await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_at) SELECT $1,'SYN foreign old',999,'2000-01-01' FROM generate_series(1,301)", [ids.outside]);
  expect((await read("own")).proposals.map(r => r.planId)).toEqual([ids.ownPlan]);
  await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_at) SELECT $1,'SYN own extra',0,'2026-10-02' FROM generate_series(1,300)", [ids.patient]);
  const result = await read("own"); expect(result.proposals).toHaveLength(300); expect(result.hasMore).toBe(true); expect(result.proposals.every(r => r.patientId === ids.patient)).toBe(true);
});
