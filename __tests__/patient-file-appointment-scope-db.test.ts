import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppointmentReadScope } from "../lib/appointment-read-scope";

// In-memory, synthetic, patient-linked fixtures only. No external database,
// unlinked-visit harness, server, credential, or production operation is used.
vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
const { ensureSchema, getPatientFile, getPool, resetPoolForTesting, doctorOwnedPatientIds } = await import("../lib/db");
let patient: number, otherPatient: number, ownedPatient: number, doctor: number, otherDoctor: number;
let visibleAppointment: number, hiddenAppointment: number, foreignAppointment: number;
let visibleVisit: number, hiddenVisit: number, foreignReferenceVisit: number;
let scope: AppointmentReadScope;

beforeAll(async () => {
  await ensureSchema();
  const pool = getPool();
  const providers = await pool.query<{ id: number }>(
    "INSERT INTO parties (kind, name) VALUES ('doctor','Synthetic scope doctor'),('doctor','Synthetic other doctor') RETURNING id",
  );
  [doctor, otherDoctor] = providers.rows.map((row) => row.id);
  const patients = await pool.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ('SCOPE-A','Synthetic A'),('SCOPE-B','Synthetic B'),('SCOPE-C','Synthetic C') RETURNING id",
  );
  [patient, otherPatient, ownedPatient] = patients.rows.map((row) => row.id);
  await pool.query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [ownedPatient, doctor]);
  const visible = await pool.query<{ id: number }>(
    "INSERT INTO appointments (patient_id,scheduled_date,scheduled_time) VALUES ($1,'2026-01-01','09:00'),($1,'2026-01-02','09:00') RETURNING id",
    [patient],
  );
  visibleAppointment = visible.rows[0].id;
  // More than the existing page cap of hidden rows, newer than visible rows.
  const hidden = await pool.query<{ id: number }>(
    `INSERT INTO appointments (patient_id,scheduled_date,scheduled_time,doctor_id,note)
     SELECT $1, '2026-10-01'::date + n, '10:00', $2, 'Synthetic hidden calendar note'
       FROM generate_series(1,60) n RETURNING id`, [patient, otherDoctor],
  );
  hiddenAppointment = hidden.rows[0].id;
  const foreign = await pool.query<{ id: number }>(
    "INSERT INTO appointments (patient_id,scheduled_date,scheduled_time,doctor_id) VALUES ($1,'2026-02-01','09:00',$2) RETURNING id",
    [otherPatient, doctor],
  );
  foreignAppointment = foreign.rows[0].id;
  await pool.query(
    "INSERT INTO appointments (patient_id,scheduled_date,scheduled_time,doctor_id) VALUES ($1,'2026-03-01','09:00',$2)",
    [ownedPatient, otherDoctor],
  );
  const visits = await pool.query<{ id: number }>(
    `INSERT INTO visits (patient_id,patient_name,appointment_id,note)
     VALUES ($1,'Synthetic A',$2,'Visible linked visit'),
            ($1,'Synthetic A',$3,'Hidden appointment linked visit'),
            ($1,'Synthetic A',$4,'Foreign appointment reference') RETURNING id`,
    [patient, visibleAppointment, hiddenAppointment, foreignAppointment],
  );
  [visibleVisit, hiddenVisit, foreignReferenceVisit] = visits.rows.map((row) => row.id);
  scope = { kind: "doctor", doctorPartyId: doctor, ownedPatientIds: await doctorOwnedPatientIds(doctor, [patient, ownedPatient]) };
}, 60_000);

afterAll(async () => { await resetPoolForTesting(); vi.unstubAllEnvs(); });

describe("patient-file calendar projection, linked synthetic records", () => {
  it("applies calendar visibility before the existing 50-appointment cap", async () => {
    const file = await getPatientFile(patient, scope);
    expect(file?.appointmentVisibility).toBe("scoped");
    expect(file?.appointments).toHaveLength(2);
    expect(file?.appointments.map((row) => row.scheduledDate)).toEqual(["2026-01-02", "2026-01-01"]);
    expect(JSON.stringify(file)).not.toContain("Synthetic hidden calendar note");
    expect(file?.appointments.every((row) => row.doctorId === null)).toBe(true);
  });

  it("keeps readable visits but projects each reference through its same-patient appointment row", async () => {
    const file = await getPatientFile(patient, scope);
    const visits = new Map(file!.visits.map((row) => [row.id, row]));
    expect(visits.get(visibleVisit)?.appointmentId).toBe(visibleAppointment);
    expect(visits.get(hiddenVisit)?.appointmentId).toBeNull();
    expect(visits.get(foreignReferenceVisit)?.appointmentId).toBeNull();
    expect(visits.get(hiddenVisit)?.note).toBe("Hidden appointment linked visit");
    expect(file?.visits).toHaveLength(3);
  });

  it("retains all-calendar readers and the original page cap without exposing foreign references", async () => {
    const file = await getPatientFile(patient, { kind: "all" });
    expect(file?.appointmentVisibility).toBe("all");
    expect(file?.appointments).toHaveLength(50);
    const visits = new Map(file!.visits.map((row) => [row.id, row]));
    // The authorized reference remains visible even if outside the 50-row list.
    expect(visits.get(visibleVisit)?.appointmentId).toBe(visibleAppointment);
    expect(visits.get(hiddenVisit)?.appointmentId).toBe(hiddenAppointment);
    expect(visits.get(foreignReferenceVisit)?.appointmentId).toBeNull();
  });

  it("preserves the canonical owned-patient exception for another provider's appointment", async () => {
    expect(scope.kind === "doctor" && scope.ownedPatientIds.has(patient)).toBe(false);
    expect(scope.kind === "doctor" && scope.ownedPatientIds.has(ownedPatient)).toBe(true);
    const file = await getPatientFile(ownedPatient, scope);
    expect(file?.appointmentVisibility).toBe("all");
    expect(file?.appointments).toHaveLength(1);
    expect(file?.appointments[0].doctorId).toBe(otherDoctor);
  });

  it("returns no calendar metadata for a no-calendar scope without removing clinical visits", async () => {
    const file = await getPatientFile(patient, { kind: "none" });
    expect(file?.appointmentVisibility).toBe("hidden");
    expect(file?.appointments).toEqual([]);
    expect(file?.visits).toHaveLength(3);
    expect(file?.visits.every((visit) => visit.appointmentId === null)).toBe(true);
  });

  it("keeps an empty permitted subset distinguishable from a calendar denial", async () => {
    const emptyScope: AppointmentReadScope = { kind: "doctor", doctorPartyId: otherDoctor, ownedPatientIds: new Set() };
    const file = await getPatientFile(otherPatient, emptyScope);
    expect(file?.appointments).toEqual([]);
    expect(file?.appointmentVisibility).toBe("scoped");
  });

  it("does not rewrite hidden or foreign references in stored clinical records", async () => {
    await getPatientFile(patient, scope);
    const { rows } = await getPool().query<{ id: number; appointment_id: number }>(
      "SELECT id, appointment_id FROM visits WHERE patient_id=$1 ORDER BY id", [patient],
    );
    expect(rows).toEqual([
      { id: visibleVisit, appointment_id: visibleAppointment },
      { id: hiddenVisit, appointment_id: hiddenAppointment },
      { id: foreignReferenceVisit, appointment_id: foreignAppointment },
    ]);
  });
});
