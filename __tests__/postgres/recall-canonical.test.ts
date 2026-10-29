/** M2 slice 24: canonical recall (GET/POST /api/recall) on real PostgreSQL, synthetic
 * data only. The lists follow the CURRENT patient scope (applied in SQL before the
 * limits); recording a follow-up is one admitted appointments.create transaction with
 * the patient inside the scope and the audit row atomic. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-recall-lists-2026");
const db = await import("../../lib/db");
const recall = await import("../../lib/canonical-recall");

const ACCOUNTS = {
  owner: { username: "SYN-RC-OWNER", role: "admin" },
  desk: { username: "SYN-RC-DESK", role: "reception", patientScope: "all", grants: { "appointments.create": true } },
  reader: { username: "SYN-RC-READER", role: "reception", patientScope: "all", grants: {} },
  doctor: { username: "SYN-RC-DOCTOR", role: "doctor", doctor: true, patientScope: "own", grants: { "appointments.create": true } },
  appointmentsOnly: { username: "SYN-RC-APPT", role: "reception", appointmentScope: "all", grants: { "appointments.create": true } },
  revoked: { username: "SYN-RC-REVOKED", role: "reception", patientScope: "all", grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const ids = { mineMissed: 0, theirsMissed: 0, mineOpen: 0, minePatient: 0, theirsPatient: 0 };
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null, createdDaysAgo: number) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,created_at) VALUES ($1,$2,'0500000400',$3,NOW() - ($4::int * INTERVAL '1 day')) RETURNING id", [number, `SYN Recall ${number}`, doctor, createdDaysAgo]))[0].id as number;
  ids.minePatient = await patient("SYN-RC-1", fx.parties.doctor!, 200);
  ids.theirsPatient = await patient("SYN-RC-2", null, 200);
  const appointment = async (patientId: number, status: string, daysAgo: number) =>
    (await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,(NOW() AT TIME ZONE $2)::date - $3::int,'10:00',$4) RETURNING id", [patientId, db.CLINIC_TIME_ZONE, daysAgo, status]))[0].id as number;
  ids.mineMissed = await appointment(ids.minePatient, "no_show", 3);
  ids.theirsMissed = await appointment(ids.theirsPatient, "no_show", 3);
  ids.mineOpen = await appointment(ids.minePatient, "booked", 2);
  await appointment(ids.theirsPatient, "booked", 2);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("the lists", () => {
  it("all scope lists every row; own lists only the clinician's patients", async () => {
    const all = await recall.readCanonicalRecall(await fx.session("desk"), 6);
    expect(all.missed.map(row => row.id).sort()).toEqual([ids.mineMissed, ids.theirsMissed].sort());
    expect(all.openPast).toHaveLength(2);
    expect(all.lapsed.map(row => row.id)).toEqual(expect.arrayContaining([ids.minePatient, ids.theirsPatient]));
    expect(all.canRecord).toBe(true);
    const own = await recall.readCanonicalRecall(await fx.session("doctor"), 6);
    expect(own.missed.map(row => row.id)).toEqual([ids.mineMissed]);
    expect(own.openPast.map(row => row.id)).toEqual([ids.mineOpen]);
    expect(own.lapsed.map(row => row.id)).toEqual([ids.minePatient]);
    expect((await recall.readCanonicalRecall(await fx.session("reader"), 6)).canRecord).toBe(false);
  });
  it("matches the legacy lists for the whole scope; an appointment scope alone does not open them; weeks are a closed list", async () => {
    const all = await recall.readCanonicalRecall(await fx.session("desk"), 6);
    expect(all.missed).toEqual(await db.listMissedAppointments());
    expect(all.lapsed).toEqual(await db.listLapsedPatients(6));
    await expect(recall.readCanonicalRecall(await fx.session("appointmentsOnly"), 6)).rejects.toThrow(/SCOPE/);
    expect(recall.recallWeeks("100000")).toBe(6);
  });
});

describe("recording a follow-up", () => {
  it("marks once, keeps the first time, audits atomically; a second mark of a missed appointment still answers ok", async () => {
    await recall.commandCanonicalRecallContact(await fx.session("desk"), "missed", ids.theirsMissed);
    const first = (await q("SELECT follow_up_at FROM appointments WHERE id=$1", [ids.theirsMissed]))[0].follow_up_at;
    await recall.commandCanonicalRecallContact(await fx.session("desk"), "missed", ids.theirsMissed);
    expect((await q("SELECT follow_up_at FROM appointments WHERE id=$1", [ids.theirsMissed]))[0].follow_up_at).toEqual(first);
    expect((await q("SELECT actor FROM audit_log WHERE action='recall.contact' AND entity_id=$1::text", [ids.theirsMissed])).map(row => row.actor)).toEqual(["SYN-RC-DESK", "SYN-RC-DESK"]);
    await recall.commandCanonicalRecallContact(await fx.session("desk"), "lapsed", ids.theirsPatient);
    expect((await q("SELECT recalled_at IS NOT NULL AS done FROM patients WHERE id=$1", [ids.theirsPatient]))[0].done).toBe(true);
  });
  it("own scope records only its own patients; another's reads like missing; bad input refuses", async () => {
    await recall.commandCanonicalRecallContact(await fx.session("doctor"), "missed", ids.mineMissed);
    const outside = await recall.commandCanonicalRecallContact(await fx.session("doctor"), "lapsed", ids.theirsPatient).catch(error => error);
    const missing = await recall.commandCanonicalRecallContact(await fx.session("doctor"), "lapsed", 999_999).catch(error => error);
    expect(outside).toMatchObject({ code: "recall_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    await expect(recall.commandCanonicalRecallContact(await fx.session("desk"), "other", 1)).rejects.toMatchObject({ code: "invalid_recall" });
    await expect(recall.commandCanonicalRecallContact(await fx.session("desk"), "missed", ids.mineOpen)).rejects.toMatchObject({ code: "recall_conflict", status: 409 });
  });
  it("no appointments.create, no patient scope or a stale session refuse before any write; an audit failure rolls back", async () => {
    await expect(recall.commandCanonicalRecallContact(await fx.session("reader"), "lapsed", ids.minePatient)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(recall.commandCanonicalRecallContact(await fx.session("appointmentsOnly"), "lapsed", ids.minePatient)).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { patientScope: "all" });
    await expect(recall.commandCanonicalRecallContact(session, "lapsed", ids.minePatient)).rejects.toThrow(/^STAFF_OPERATION_/);
    await q("ALTER TABLE audit_log ADD CONSTRAINT syn_recall_refuses CHECK (action <> 'recall.contact') NOT VALID");
    try {
      await expect(recall.commandCanonicalRecallContact(await fx.session("desk"), "lapsed", ids.minePatient)).rejects.toThrow();
    } finally { await q("ALTER TABLE audit_log DROP CONSTRAINT syn_recall_refuses"); }
    expect((await q("SELECT recalled_at FROM patients WHERE id=$1", [ids.minePatient]))[0].recalled_at).toBeNull();
  });
});
