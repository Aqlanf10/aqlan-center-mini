/** Scope is decided after real PostgreSQL waits, on the writing transaction.
 * Synthetic data only. pg_stat_activity, not timing or mocked query results,
 * establishes every lock-wait interleaving. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-visit-scope-race-secret-2026");
const db = await import("../../lib/db");
const vf = await import("../../lib/canonical-visit-file");
const cr = await import("../../lib/canonical-clinical-records");
const accounts = {
  owner: { username: "SYN-SCOPE-OWNER", role: "admin" },
  doctor: { username: "SYN-SCOPE-DOC", role: "doctor", doctor: true, patientScope: "own", grants: {
    "visits.manage": true, "visits.delete": true, "patients.create": true, "clinical.visits.document": true,
  } },
  other: { username: "SYN-SCOPE-OTHER", role: "doctor", doctor: true, patientScope: "own", grants: {} },
} as const;
let fx: CanonicalInventoryDatabase<keyof typeof accounts>;
let blockers: Pool;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const outcome = (promise: Promise<unknown>) => promise.then(value => ({ value }), error => ({ error }));
const noAudit = async (action: string, id: number) => {
  expect(await q("SELECT id FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, id])).toHaveLength(0);
};
let count = 0;
const patient = async (doctor: number | null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
  [`SYN-SCOPE-${++count}`, "Synthetic Scope Patient", doctor],
))[0].id as number;
const visit = async (doctor = fx.parties.doctor!, patientId: number | null = null) => (await q(
  "INSERT INTO visits(patient_name,doctor_id,patient_id) VALUES ('SYN scope visitor',$1,$2) RETURNING id", [doctor, patientId],
))[0].id as number;
const appointment = async (patientId: number) => (await q(
  `INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,duration_minutes,status)
   VALUES ($1,$2,'2031-01-10','10:00',30,'confirmed') RETURNING id`, [patientId, fx.parties.doctor],
))[0].id as number;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, accounts, "owner");
  // The fixture's observer pool has max=1. Blockers must use independent connections.
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 5 });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

async function observedWait(queryText: string) {
  for (let i = 0; i < 500; i++) {
    const rows = await q(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
      [`%${queryText}%`],
    );
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Did not observe PostgreSQL lock wait: ${queryText}`);
}

async function afterLockedChange(
  change: (client: PoolClient) => Promise<unknown>, start: () => Promise<unknown>, waitingQuery: string,
) {
  const blocker = await blockers.connect();
  let pending: ReturnType<typeof outcome> | undefined;
  try {
    await blocker.query("BEGIN");
    await change(blocker);
    pending = outcome(start());
    await observedWait(waitingQuery);
    await blocker.query("COMMIT");
    return await pending;
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
}

it("open_file refuses a visit that leaves scope during its row-lock wait", async () => {
  const target = await patient(fx.parties.other!), v = await visit(), session = await fx.session("doctor");
  const result = await afterLockedChange(
    client => client.query("UPDATE visits SET doctor_id=$2,patient_id=$3 WHERE id=$1", [v, fx.parties.other, target]),
    () => vf.commandCanonicalVisitOpenFile(session, String(v)), "FROM visits WHERE id",
  );
  expect(await db.patientInDoctorScopeWith(fx.pool, fx.parties.doctor!, target)).toBe(false);
  expect(result).toMatchObject({ error: { code: "visit_not_found", status: 404 } });
  expect((await q("SELECT patient_id FROM visits WHERE id=$1", [v]))[0].patient_id).toBe(target);
  await noAudit("patient.create", target);
});

it("link refuses a visit that leaves scope during its row-lock wait", async () => {
  const mine = await patient(fx.parties.doctor!), far = await patient(fx.parties.other!), v = await visit();
  const session = await fx.session("doctor");
  const result = await afterLockedChange(
    client => client.query("UPDATE visits SET doctor_id=$2,patient_id=$3 WHERE id=$1", [v, fx.parties.other, far]),
    () => vf.commandCanonicalVisitLink(session, String(v), mine), "FROM visits WHERE id",
  );
  expect(result).toMatchObject({ error: { code: "visit_not_found", status: 404 } });
  expect((await q("SELECT patient_id,doctor_id FROM visits WHERE id=$1", [v]))[0])
    .toEqual({ patient_id: far, doctor_id: fx.parties.other });
  await noAudit("visit.link", v);
});

it("delete preserves a visit that leaves scope during its row-lock wait", async () => {
  const far = await patient(fx.parties.other!), v = await visit(), session = await fx.session("doctor");
  const result = await afterLockedChange(
    client => client.query("UPDATE visits SET doctor_id=$2,patient_id=$3 WHERE id=$1", [v, fx.parties.other, far]),
    () => vf.commandCanonicalVisitDelete(session, String(v), "SYN race witness"), "FROM visits WHERE id",
  );
  expect(result).toMatchObject({ error: { code: "visit_not_found", status: 404 } });
  expect(await q("SELECT id FROM visits WHERE id=$1", [v])).toHaveLength(1);
  await noAudit("visit.delete", v);
});

it("vitals preserves the alert when patient ownership changes during its row-lock wait", async () => {
  const id = await patient(fx.parties.doctor!), session = await fx.session("doctor");
  const result = await afterLockedChange(
    client => client.query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [id, fx.parties.other]),
    () => cr.commandCanonicalVitals(session, String(id), {
      requestKey: "SYN-Scope-Vitals-0001", pulse: 71, medicalAlert: "SYN unexpected scope write",
    }), "SELECT id FROM patients WHERE id = $1 FOR UPDATE",
  );
  expect(await db.patientInDoctorScopeWith(fx.pool, fx.parties.doctor!, id)).toBe(false);
  expect(result).toMatchObject({ error: { code: "patient_not_found", status: 404 } });
  expect((await q("SELECT medical_alert FROM patients WHERE id=$1", [id]))[0].medical_alert).toBeNull();
  expect(await q("SELECT id FROM patient_vitals WHERE patient_id=$1", [id])).toHaveLength(0);
  await noAudit("patient.vitals", id);
});

it.each(["open_file", "link", "delete"] as const)("%s rechecks indirect appointment scope after the visit wait", async action => {
  const id = await patient(null), appointmentId = await appointment(id), v = await visit(fx.parties.other!, id);
  const target = await patient(fx.parties.doctor!), session = await fx.session("doctor");
  expect(await db.patientInDoctorScopeWith(fx.pool, fx.parties.doctor!, id)).toBe(true);
  const result = await afterLockedChange(async client => {
    await client.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [v]);
    await client.query("UPDATE appointments SET doctor_id=$2 WHERE id=$1", [appointmentId, fx.parties.other]);
  }, () => action === "open_file" ? vf.commandCanonicalVisitOpenFile(session, String(v))
    : action === "link" ? vf.commandCanonicalVisitLink(session, String(v), target)
    : vf.commandCanonicalVisitDelete(session, String(v), "SYN indirect scope"), "FROM visits WHERE id");
  expect(result).toMatchObject({ error: { code: "visit_not_found", status: 404 } });
  expect(await db.patientInDoctorScopeWith(fx.pool, fx.parties.doctor!, id)).toBe(false);
  expect((await q("SELECT patient_id FROM visits WHERE id=$1", [v]))[0].patient_id).toBe(id);
  await noAudit("visit.link", v);
  await noAudit("visit.delete", v);
});

it("link rechecks the target patient before its own link can manufacture scope", async () => {
  const target = await patient(fx.parties.doctor!), v = await visit(), session = await fx.session("doctor");
  const result = await afterLockedChange(async client => {
    await client.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [v]);
    await client.query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [target, fx.parties.other]);
  }, () => vf.commandCanonicalVisitLink(session, String(v), target), "FROM visits WHERE id");
  expect(result).toMatchObject({ error: { code: "patient_not_found", status: 404 } });
  expect((await q("SELECT patient_id FROM visits WHERE id=$1", [v]))[0].patient_id).toBeNull();
  expect(await db.patientInDoctorScopeWith(fx.pool, fx.parties.doctor!, target)).toBe(false);
  await noAudit("visit.link", v);
});

it("open_file checks a phone-matched patient after the visit wait and before linking", async () => {
  const target = await patient(fx.parties.doctor!), v = await visit(), session = await fx.session("doctor");
  await q("UPDATE patients SET phone='0500000901' WHERE id=$1", [target]);
  await q("UPDATE visits SET patient_phone='0500000901' WHERE id=$1", [v]);
  const result = await afterLockedChange(async client => {
    await client.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [v]);
    await client.query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [target, fx.parties.other]);
  }, () => vf.commandCanonicalVisitOpenFile(session, String(v)), "FROM visits WHERE id");
  expect(result).toMatchObject({ error: { code: "visit_open_file_outside_scope", status: 409 } });
  expect((await q("SELECT patient_id FROM visits WHERE id=$1", [v]))[0].patient_id).toBeNull();
  await noAudit("patient.create", target);
});

it("vitals rechecks appointment-derived ownership after the patient wait", async () => {
  const id = await patient(null), appointmentId = await appointment(id), session = await fx.session("doctor");
  const result = await afterLockedChange(async client => {
    await client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [id]);
    await client.query("UPDATE appointments SET doctor_id=$2 WHERE id=$1", [appointmentId, fx.parties.other]);
  }, () => cr.commandCanonicalVitals(session, String(id), {
    requestKey: "SYN-Scope-Vitals-0002", pulse: 72,
  }), "SELECT id FROM patients WHERE id = $1 FOR UPDATE");
  expect(result).toMatchObject({ error: { code: "patient_not_found", status: 404 } });
  expect(await q("SELECT id FROM patient_vitals WHERE patient_id=$1", [id])).toHaveLength(0);
  await noAudit("patient.vitals", id);
});

// Deliberately keep the blocker uncommitted while awaiting the command: NOWAIT
// must return a bounded 409, not wait in inverse order until deadlock detection.
async function refusesWithoutWaiting(change: (client: PoolClient) => Promise<unknown>, start: () => Promise<unknown>) {
  const blocker = await blockers.connect();
  let pending: ReturnType<typeof outcome> | undefined;
  try {
    await blocker.query("BEGIN");
    await change(blocker);
    pending = outcome(start());
    const result = await Promise.race([pending, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Scope witness waited instead of refusing contention")), 5_000);
      void pending!.finally(() => clearTimeout(timer));
    })]);
    return result;
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
}

it.each(["open_file", "link"] as const)("%s refuses an inverse patient lock without waiting or effects", async action => {
  const target = await patient(fx.parties.doctor!), v = await visit(), session = await fx.session("doctor");
  await q("UPDATE patients SET phone=$2 WHERE id=$1", [target, `05000009${action === "link" ? "02" : "03"}`]);
  await q("UPDATE visits SET patient_phone=(SELECT phone FROM patients WHERE id=$2) WHERE id=$1", [v, target]);
  const result = await refusesWithoutWaiting(
    client => client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [target]),
    () => action === "link" ? vf.commandCanonicalVisitLink(session, String(v), target)
      : vf.commandCanonicalVisitOpenFile(session, String(v)),
  );
  expect(result).toMatchObject({ error: { code: "visit_scope_conflict", status: 409 } });
  expect((await q("SELECT patient_id FROM visits WHERE id=$1", [v]))[0].patient_id).toBeNull();
  await noAudit("visit.link", v);
  await noAudit("patient.create", target);
});

it("vitals refuses a busy relationship witness without waiting backwards", async () => {
  const id = await patient(null), appointmentId = await appointment(id), session = await fx.session("doctor");
  const result = await refusesWithoutWaiting(
    client => client.query("UPDATE appointments SET doctor_id=$2 WHERE id=$1", [appointmentId, fx.parties.other]),
    () => cr.commandCanonicalVitals(session, String(id), { requestKey: "SYN-Scope-Vitals-0003", pulse: 73 }),
  );
  expect(result).toMatchObject({ error: { code: "clinical_record_scope_conflict", status: 409 } });
  expect(await q("SELECT id FROM patient_vitals WHERE patient_id=$1", [id])).toHaveLength(0);
  await noAudit("patient.vitals", id);
});

it("vitals holds the positive appointment witness until the reading and audit commit", async () => {
  const id = await patient(null), appointmentId = await appointment(id), session = await fx.session("doctor");
  const gate = await blockers.connect(), reassignment = await blockers.connect();
  let pending: ReturnType<typeof outcome> | undefined, changed: ReturnType<typeof outcome> | undefined;
  try {
    await gate.query("BEGIN");
    await gate.query("LOCK TABLE patient_vitals IN ACCESS EXCLUSIVE MODE");
    pending = outcome(cr.commandCanonicalVitals(session, String(id), { requestKey: "SYN-Scope-Vitals-0004", pulse: 74 }));
    // The writer has already validated scope, but cannot insert or commit yet.
    await observedWait("INSERT INTO patient_vitals");
    changed = outcome(reassignment.query("UPDATE appointments SET doctor_id=$2 WHERE id=$1", [appointmentId, fx.parties.other]));
    await observedWait("UPDATE appointments SET doctor_id");
    await gate.query("COMMIT");
    expect(await pending).toMatchObject({ value: { patientId: id, pulse: 74, replayed: false } });
    expect(await changed).toHaveProperty("value");
  } finally {
    await gate.query("ROLLBACK");
    gate.release();
    await pending;
    await changed;
    reassignment.release();
  }
  expect(await db.patientInDoctorScopeWith(fx.pool, fx.parties.doctor!, id)).toBe(false);
  expect(await q("SELECT id FROM patient_vitals WHERE patient_id=$1", [id])).toHaveLength(1);
  expect(await q("SELECT id FROM audit_log WHERE action='patient.vitals' AND entity_id=$1::text", [id])).toHaveLength(1);
});
