import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalOrthoFollowups } from "../fixtures/canonical-ortho-followups";
import type { CanonicalSnapshotQuery } from "../../lib/canonical-read-snapshot";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ortho-followups-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ortho-followups"), snapshots = await import("../../lib/canonical-read-snapshot");
const { clinicDateString } = await import("../../lib/schedule");
const VIEW = { "clinical.ortho.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-OF-OWNER", role: "admin" },
  own: { username: "SYN-OF-OWN", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: VIEW },
  all: { username: "SYN-OF-ALL", role: "reception", patientScope: "all", appointmentScope: "all", grants: VIEW },
  clinical: { username: "SYN-OF-CLINICAL", role: "admin", patientScope: "all", appointmentScope: "none", grants: VIEW },
  none: { username: "SYN-OF-NONE", role: "doctor", doctor: true, patientScope: "none", appointmentScope: "all", grants: VIEW },
  unlinked: { username: "SYN-OF-UNLINKED", role: "doctor", patientScope: "own", appointmentScope: "all", grants: VIEW },
  adjacent: { username: "SYN-OF-ADJACENT", role: "admin", patientScope: "all", appointmentScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, ids: Awaited<ReturnType<typeof seedCanonicalOrthoFollowups>>;
const read = async (key: Key) => reads.readCanonicalOrthoFollowups(await fx.session(key));
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  ids = await seedCanonicalOrthoFollowups(fx.pool, fx.parties.own!, fx.parties.none!, clinicDateString(new Date(), db.CLINIC_TIME_ZONE));
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it("requires the mapped independent ortho grant and patient scope", async () => {
  const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
  expect(CANONICAL_RECORD_READS["read:ortho.followups"]).toEqual({ record: "patient", need: ["clinical.ortho.view"], anyOf: [] });
});
it.each(["none", "unlinked", "adjacent"] as const)("denies %s without widening authority from a role or appointment scope", async key => {
  await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);
});
it("own patients and own appointments are separate intersections, including scoped no-show history", async () => {
  const result = await read("own"); expect(result.rows).toHaveLength(1); expect(result.appointmentCoverage).toBe("own");
  expect(result.rows[0]).toMatchObject({ caseId: ids.caseId, schedule: { nextAppointment: { id: ids.ownBooking }, hasRecordedNoShow: false } });
  expect(result.rows[0].buckets).toContain("today"); expect(result.rows[0].buckets).not.toContain("no_show");
  expect(result.rows[0].schedule?.otherAppointments).toEqual([]);
  expect(result.rows[0].schedule?.reviewAppointments.map(a => a.id)).toEqual([ids.unknown]);
});
it.each(["owner", "all"] as const)("%s can read the whole admitted schedule without finance or hidden clinical detail", async key => {
  const result = await read(key); expect(result.rows).toHaveLength(2); expect(result.appointmentCoverage).toBe("all");
  const row = result.rows.find(r => r.caseId === ids.caseId)!;
  expect(row.buckets).toContain("no_show"); expect(row.schedule?.hasRecordedNoShow).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/SYN private|patientPhone|upperWire|lowerWire|planId|clinicalCaseId|Minor|currency|invoice|payment|financial|visitId/i);
  expect(Object.keys(row).sort()).toEqual(["buckets", "caseId", "daysSinceLast", "dueDate", "lastAdjustmentDate", "nextWeeks", "patientId", "patientName", "phase", "schedule", "startDate", "status"]);
  expect(Object.keys(row.schedule!).sort()).toEqual(["hasRecordedNoShow", "nextAppointment", "otherAppointments", "pastUnresolvedAppointment", "reviewAppointments"]);
});
function instrument(wrap: (query: CanonicalSnapshotQuery) => CanonicalSnapshotQuery) {
  const original = snapshots.runCanonicalReadSnapshot;
  return vi.spyOn(snapshots, "runCanonicalReadSnapshot").mockImplementationOnce((session, key, reader, options) => original(session, key, (q, scope) => reader(wrap(q), scope), options));
}
it("appointment none performs no appointment or plan query and never invents no-appointment status", async () => {
  const sql: string[] = [], spy = instrument(q => ({ query: async (text, values) => { sql.push(text); return q.query(text, values); } }));
  try {
    const result = await read("clinical"); expect(result.appointmentCoverage).toBe("none");
    expect(result.rows.every(row => row.schedule === null && row.buckets.every(b => ["lapsed_4", "lapsed_6", "lapsed_8", "retention"].includes(b)))).toBe(true);
    expect(sql.some(text => /\b(appointments|treatment_plans|plan_items|treatment_sessions)\b/i.test(text))).toBe(false);
  } finally { spy.mockRestore(); }
});
it("hidden bookings never become a false no-appointment claim under own coverage", async () => {
  await fx.pool.query("UPDATE appointments SET doctor_id=$1 WHERE id=ANY($2::int[])", [fx.parties.none, [ids.ownBooking, ids.unknown]]);
  try { const row = (await read("own")).rows[0]; expect(row.schedule?.nextAppointment).toBeNull(); expect(row.buckets).not.toContain("no_appointment"); expect(row.buckets).not.toContain("no_show"); }
  finally { await fx.pool.query("UPDATE appointments SET doctor_id=$1 WHERE id=ANY($2::int[])", [fx.parties.own, [ids.ownBooking, ids.unknown]]); }
});
it("clinical-only results are invariant when hidden booking facts change", async () => {
  const before = await read("clinical"); await fx.pool.query("UPDATE appointments SET status='cancelled' WHERE id=$1", [ids.otherBooking]);
  try { expect(await read("clinical")).toEqual(before); }
  finally { await fx.pool.query("UPDATE appointments SET status='booked' WHERE id=$1", [ids.otherBooking]); }
});
it("unknown booking lineage remains reviewable, not silently declared periodic", async () => {
  const row = (await read("all")).rows.find(r => r.caseId === ids.caseId)!;
  expect(row.schedule?.reviewAppointments.map(a => a.id)).toContain(ids.unknown);
  expect(row.schedule?.nextAppointment?.id).toBe(ids.ownBooking);
});
it("a foreign bridge fails closed without repairing or materializing its clinical details", async () => {
  const bridge = (await fx.pool.query("INSERT INTO clinical_cases(patient_id,ortho_case_id,specialty,title,created_by) VALUES($1,$2,'orthodontics','SYN foreign bridge','SYN') RETURNING id", [ids.outside, ids.caseId])).rows[0].id;
  try { await expect(read("owner")).rejects.toMatchObject({ code: "ortho_followup_reference" }); }
  finally { await fx.pool.query("DELETE FROM clinical_cases WHERE id=$1", [bridge]); }
});
it("bounds current cases before expansion and declares the incomplete list honestly", async () => {
  const patients = (await fx.pool.query("INSERT INTO patients(patient_number,full_name) SELECT 'SYN-OF-LIMIT-'||n,'SYN limit patient' FROM generate_series(1,300) n RETURNING id")).rows.map(r => r.id);
  const extras = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,start_date,created_by) SELECT unnest($1::int[]),'2025-01-01','SYN-limit' RETURNING id", [patients])).rows.map(r => r.id);
  try { const all = await read("all"); expect(all.rows).toHaveLength(300); expect(all.hasMore).toBe(true); const own = await read("own"); expect(own.rows).toHaveLength(1); expect(own.hasMore).toBe(false); }
  finally { await fx.pool.query("DELETE FROM ortho_cases WHERE id=ANY($1::int[])", [extras]); await fx.pool.query("DELETE FROM patients WHERE id=ANY($1::int[])", [patients]); }
});
it("rejects an oversized scoped booking set before it can become a partial schedule", async () => {
  const extras = (await fx.pool.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,doctor_id) SELECT $1,CURRENT_DATE,'16:00','booked',$2 FROM generate_series(1,2001) RETURNING id", [ids.patient, fx.parties.none])).rows.map(r => r.id);
  try { await expect(read("all")).rejects.toMatchObject({ code: "ortho_followup_limit" }); expect((await read("own")).rows).toHaveLength(1); expect((await read("clinical")).rows).toHaveLength(2); }
  finally { await fx.pool.query("DELETE FROM appointments WHERE id=ANY($1::int[])", [extras]); }
});
it("limits selected bytes before transferring text without clipping a clinical name", async () => {
  const patients = (await fx.pool.query("INSERT INTO patients(patient_number,full_name) SELECT 'SYN-OF-BYTES-'||n,repeat('x',8000)||n FROM generate_series(1,300) n RETURNING id")).rows.map(r => r.id);
  await fx.pool.query("INSERT INTO ortho_cases(patient_id,start_date,created_by) SELECT unnest($1::int[]),'2023-01-01','SYN-bytes'", [patients]);
  try { await expect(read("clinical")).rejects.toMatchObject({ code: "ortho_followup_limit" }); }
  finally { await fx.pool.query("DELETE FROM ortho_cases WHERE patient_id=ANY($1::int[])", [patients]); await fx.pool.query("DELETE FROM patients WHERE id=ANY($1::int[])", [patients]); }
});
it("uses one read-only repeatable-read connection without audit, initialization or financial effects", async () => {
  const before = (await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM clinical_cases)::int AS bridges")).rows;
  const session = await fx.session("all"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), poolQuery = vi.spyOn(pool, "query");
  const spy = instrument(q => ({ query: async (text, values) => {
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    expect(text).not.toMatch(/\b(invoices|payments|journal_entries|plan_installments)\b/i); return q.query(text, values);
  } }));
  try { await reads.readCanonicalOrthoFollowups(session); expect(connect).toHaveBeenCalledTimes(1); expect(poolQuery).not.toHaveBeenCalled(); }
  finally { spy.mockRestore(); connect.mockRestore(); poolQuery.mockRestore(); }
  expect((await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM clinical_cases)::int AS bridges")).rows).toEqual(before);
});
it("membership, adjustment and appointments stay in one snapshot during a concurrent commit", async () => {
  let changed = false;
  const spy = instrument(q => ({ query: async (text, values) => {
    if (!changed) { changed = true; const writer = await side.connect(); try { await writer.query("BEGIN"); await writer.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.patient]); await writer.query("UPDATE ortho_adjustments SET next_weeks=6 WHERE id=$1", [ids.adjustment]); await writer.query("UPDATE appointments SET status='cancelled' WHERE id=$1", [ids.ownBooking]); await writer.query("COMMIT"); } finally { await writer.query("ROLLBACK"); writer.release(); } }
    return q.query(text, values);
  } }));
  try {
    const row = (await read("own")).rows[0]; expect(row.nextWeeks).toBe(4); expect(row.schedule?.nextAppointment?.id).toBe(ids.ownBooking);
    spy.mockRestore(); const next = (await read("all")).rows.find(r => r.caseId === ids.caseId)!; expect(next.nextWeeks).toBe(6); expect(next.schedule?.nextAppointment?.id).toBe(ids.otherBooking);
  } finally { spy.mockRestore(); await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.patient]); await side.query("UPDATE ortho_adjustments SET next_weeks=4 WHERE id=$1", [ids.adjustment]); await side.query("UPDATE appointments SET status='booked' WHERE id=$1", [ids.ownBooking]); }
});
it("expires a session that waited behind the real lifecycle fence", async () => {
  const session = await fx.session("all", 1500), holder = await side.connect();
  try { await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalOrthoFollowups(session); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("re-proves a revoked grant after waiting, with no legacy fallback", async () => {
  const session = await fx.session("all"), holder = await side.connect();
  try { await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all", appointmentScope: "all" }, 2)), fx.ids.all]);
    const pending = reads.readCanonicalOrthoFollowups(session); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(); await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all", appointmentScope: "all" }); }
});
it("appointment scope withdrawal hides schedules on the next fresh authority", async () => {
  const stale = await fx.session("all"); await fx.setGrants("all", VIEW, { patientScope: "all", appointmentScope: "none" });
  try { await expect(reads.readCanonicalOrthoFollowups(stale)).rejects.toThrow(); expect((await read("all")).rows.every(row => row.schedule === null)).toBe(true); }
  finally { await fx.setGrants("all", VIEW, { patientScope: "all", appointmentScope: "all" }); }
});
it("a failed query publishes nothing and does not poison the next lease", async () => {
  const spy = instrument(() => ({ query: async () => { throw new Error("SYN private query failure"); } }));
  try { await expect(read("all")).rejects.toThrow(); } finally { spy.mockRestore(); }
  expect((await read("all")).rows).toHaveLength(2);
});
it("credential retirement invalidates previously admitted read handles", async () => {
  const session = await fx.session("own");
  await fx.pool.query("UPDATE users SET password_hash='SYN retired followup hash' WHERE id=$1", [fx.ids.own]);
  await expect(reads.readCanonicalOrthoFollowups(session)).rejects.toThrow(/STALE/);
  expect((await read("own")).rows).toHaveLength(1);
});
