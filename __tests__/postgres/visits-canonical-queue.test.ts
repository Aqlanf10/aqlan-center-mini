/** M2 slice 11: canonical Today queue (GET /api/visits) and arrival (POST /api/visits)
 * on real PostgreSQL, synthetic data only. The queue lists only visits inside the
 * actor's current patient scope; the arrival is one admitted `visits.manage`
 * transaction with the patient inside that scope (outside = missing) and its audit. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-visit-queue-2026");
const db = await import("../../lib/db");
const visits = await import("../../lib/canonical-visits");

const MANAGE = { "visits.manage": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-Q-OWNER", role: "admin" },
  reception: { username: "SYN-Q-RECEPTION", role: "reception", patientScope: "all", grants: { ...MANAGE, "patients.operational-summary.view": true } },
  viewer: { username: "SYN-Q-VIEWER", role: "reception", patientScope: "all", grants: {} },
  doctor: { username: "SYN-Q-DOCTOR", role: "doctor", doctor: true, patientScope: "own", grants: { ...MANAGE, "clinical.plans.view": true } },
  other: { username: "SYN-Q-OTHER", role: "doctor", doctor: true, patientScope: "own", grants: MANAGE },
  noScope: { username: "SYN-Q-NOSCOPE", role: "reception", patientScope: "none", grants: MANAGE },
  revoked: { username: "SYN-Q-REVOKED", role: "reception", patientScope: "all", grants: MANAGE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let mine = 0, theirs = 0, free = 0, inactiveDoctor = 0;

const queue = async (k: Key) => visits.readCanonicalTodayVisits(await fx.session(k));
const arrive = async (k: Key, body: Record<string, unknown>) => visits.commandCanonicalArrival(await fx.session(k), visits.parseCanonicalArrival(body));
const names = (rows: readonly { patientName: string }[]) => rows.map(row => row.patientName).sort();
const visitCount = async () => Number((await fx.pool.query("SELECT count(*) FROM visits")).rows[0].count);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,'0500000000',$3) RETURNING id", [number, `SYN Queue ${number}`, doctor])).rows[0].id;
  mine = await patient("SYN-Q-1", fx.parties.doctor!);
  theirs = await patient("SYN-Q-2", fx.parties.other!);
  free = await patient("SYN-Q-3", null);
  inactiveDoctor = (await fx.pool.query<{ id: number }>("INSERT INTO parties(name,kind,is_active) VALUES('SYN inactive doctor','doctor',false) RETURNING id")).rows[0].id;
  const visit = (name: string, patientId: number | null, doctorId: number | null, arrived = "NOW()") =>
    fx.pool.query(`INSERT INTO visits(patient_name,note,patient_id,doctor_id,arrived_at) VALUES($1,'Synthetic arrival note',$2,$3,${arrived})`, [name, patientId, doctorId]);
  await visit("SYN mine waiting", mine, null);
  await visit("SYN theirs waiting", theirs, fx.parties.other!);
  await visit("SYN walk-in for doctor", null, fx.parties.doctor!);
  await visit("SYN walk-in unassigned", null, null);
  await visit("SYN yesterday", mine, fx.parties.doctor!, "NOW() - interval '2 days'");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("queue read", () => {
  it("all scope lists every visit of the clinic day; the note follows the operational summary", async () => {
    const view = await queue("reception");
    expect(names(view.visits)).toEqual(["SYN mine waiting", "SYN theirs waiting", "SYN walk-in for doctor", "SYN walk-in unassigned"]);
    expect(view).toMatchObject({ projection: { note: true }, canManage: true });
    expect(view.visits[0].note).toBe("Synthetic arrival note");
  });
  it("own scope lists the clinician's assigned visits and its patients' visits, nothing else", async () => {
    expect(names((await queue("doctor")).visits)).toEqual(["SYN mine waiting", "SYN walk-in for doctor"]);
    const other = await queue("other");
    expect(names(other.visits)).toEqual(["SYN theirs waiting"]);
    expect(other.projection.note).toBe(false);
    expect(other.visits[0]).not.toHaveProperty("note");
  });
  it("without visits.manage the read still works and canManage is false; no scope is refused", async () => {
    expect(await queue("viewer")).toMatchObject({ canManage: false, projection: { note: false } });
    await expect(queue("noScope")).rejects.toThrow(/RECORD_SCOPE_DENIED/);
  });
});

describe("arrival", () => {
  it("a walk-in without a file: created with its audit row under the canonical actor", async () => {
    const visit = await arrive("reception", { patientName: " SYN new walk-in ", patientPhone: "0511111111", note: "Synthetic" });
    expect(visit).toMatchObject({ patientName: "SYN new walk-in", patientPhone: "0511111111", patientId: null, doctorId: null, status: "waiting" });
    const { rows } = await fx.pool.query("SELECT actor FROM audit_log WHERE entity='visit' AND entity_id=$1::text AND action='visit.create'", [visit.id]);
    expect(rows.map(row => row.actor)).toEqual(["SYN-Q-RECEPTION"]);
  });
  it("a file inside the scope arrives once; a second arrival names the active visit", async () => {
    const visit = await arrive("reception", { patientId: free, patientName: "SYN Queue SYN-Q-3" });
    await expect(arrive("reception", { patientId: free, patientName: "SYN Queue SYN-Q-3" })).rejects.toMatchObject({ code: "visit_already_active", status: 409, visitId: visit.id });
  });
  it("own scope: outside equals missing, the visit opens on the clinician's own party, another doctor is refused", async () => {
    const before = await visitCount();
    const outside = await arrive("doctor", { patientId: theirs, patientName: "x" }).catch(error => error);
    const missing = await arrive("doctor", { patientId: 999_999, patientName: "x" }).catch(error => error);
    expect(outside).toMatchObject({ code: "patient_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    await expect(arrive("doctor", { patientName: "SYN other doctor walk-in", doctorId: fx.parties.other! })).rejects.toMatchObject({ code: "visit_doctor_not_allowed", status: 403 });
    expect(await visitCount()).toBe(before);
    expect(await arrive("doctor", { patientName: "SYN own walk-in" })).toMatchObject({ doctorId: fx.parties.doctor! });
  });
  it("all scope may name an active doctor only", async () => {
    await expect(arrive("reception", { patientName: "SYN x", doctorId: inactiveDoctor })).rejects.toMatchObject({ code: "invalid_visit_input", status: 400 });
    expect(await arrive("reception", { patientName: "SYN assigned walk-in", doctorId: fx.parties.other! })).toMatchObject({ doctorId: fx.parties.other! });
  });
  it("admission: no visits.manage, no scope, stale session after revocation", async () => {
    await expect(arrive("viewer", { patientName: "SYN x" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(arrive("noScope", { patientName: "SYN x" })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { patientScope: "all" });
    await expect(visits.commandCanonicalArrival(session, visits.parseCanonicalArrival({ patientName: "SYN x" }))).rejects.toThrow(/^STAFF_OPERATION_/);
  });
  it("an audit failure leaves no visit", async () => {
    const before = await visitCount();
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_visit_audit_refuses CHECK (actor <> 'SYN-Q-RECEPTION') NOT VALID");
    try {
      await expect(arrive("reception", { patientName: "SYN must not persist" })).rejects.toThrow();
      expect(await visitCount()).toBe(before);
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_visit_audit_refuses"); }
  });
  it("input is validated before admission", () => {
    expect(() => visits.parseCanonicalArrival({ patientName: "" })).toThrow(expect.objectContaining({ code: "invalid_visit_input" }));
    expect(() => visits.parseCanonicalArrival({ patientName: "x", isOwner: true })).toThrow(expect.objectContaining({ code: "invalid_visit_input" }));
    expect(() => visits.parseCanonicalArrival({ patientName: "x", patientId: -1 })).toThrow(expect.objectContaining({ code: "invalid_visit_input" }));
    expect(() => visits.parseCanonicalArrival({ plannedVisitId: 1, patientId: 2 })).toThrow(expect.objectContaining({ code: "invalid_visit_input" }));
  });
});

describe("planned-visit start", () => {
  it("checks the planned patient against the scope before any write, then starts once", async () => {
    const plannedFor = async (patientId: number, doctorId: number | null) =>
      (await fx.pool.query<{ id: number }>("INSERT INTO planned_visits(patient_id,sequence,title,doctor_id) VALUES($1,1,'Synthetic adjustment',$2) RETURNING id", [patientId, doctorId])).rows[0].id;
    const outsidePlan = await plannedFor(theirs, fx.parties.other!);
    const before = await visitCount();
    await expect(arrive("doctor", { plannedVisitId: outsidePlan })).rejects.toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await visitCount()).toBe(before);
    expect((await fx.pool.query("SELECT status FROM planned_visits WHERE id=$1", [outsidePlan])).rows[0].status).toBe("planned");

    const ownPlan = await plannedFor(mine, fx.parties.doctor!);
    // The patient already has an active visit today ("SYN mine waiting" was seeded without
    // the planned link), so the start itself is allowed and links the plan.
    const started = await arrive("doctor", { plannedVisitId: ownPlan });
    expect(started).toMatchObject({ patientId: mine, doctorId: fx.parties.doctor!, note: "مخطَّط: Synthetic adjustment" });
    expect((await fx.pool.query("SELECT status, visit_id FROM planned_visits WHERE id=$1", [ownPlan])).rows[0]).toEqual({ status: "in_progress", visit_id: started.id });
    const { rows } = await fx.pool.query("SELECT actor FROM audit_log WHERE entity='visit' AND entity_id=$1::text AND action='visit.create'", [started.id]);
    expect(rows.map(row => row.actor)).toEqual(["SYN-Q-DOCTOR"]);
    await expect(arrive("doctor", { plannedVisitId: ownPlan })).rejects.toMatchObject({ code: "visit_already_active", visitId: started.id });
    await expect(arrive("reception", { plannedVisitId: 999_999 })).rejects.toMatchObject({ code: "planned_visit_not_found", status: 404 });
  });
});
