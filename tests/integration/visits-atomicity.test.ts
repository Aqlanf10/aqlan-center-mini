import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { createTestDatabase, type TestDatabase } from "./helpers";

/**
 * Visit lifecycle integrity against real PostgreSQL:
 *   - start / create / complete each run as ONE transaction
 *     (clinical writes + appointment status + commissions + next
 *     appointment + audit rows commit or roll back together),
 *   - audits live INSIDE the transaction (no movement without audit),
 *   - concurrent starts produce ONE draft visit,
 *   - concurrent completions produce ONE completion, ONE next appointment,
 *     ONE audit and ONE set of commissions (alreadyCompleted domain result),
 *   - a mid-transaction failure rolls EVERYTHING back.
 */

describe("visit atomicity & concurrency (integration)", () => {
  let testDb: TestDatabase;
  let adminId = "";
  let doctorId = "";
  let patientId = "";
  let serviceId = "";

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const admin = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'مدير الزيارات', 'visits_admin', 'vadmin@t.local', true, 'ADMIN', true, now(), now()) RETURNING id`;
      adminId = admin[0]!.id;
      const doctor = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'د. زيارة', 'visits_doc', 'vdoc@t.local', true, 'DOCTOR', true, now(), now()) RETURNING id`;
      doctorId = doctor[0]!.id;
      const patient = await sql`INSERT INTO patients (id, file_number, full_name, gender, mobile, treatment_status, recall_interval_days, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'P-930001', 'مريض الزيارات', 'FEMALE', '777333444', 'NEW', 30, true, now(), now()) RETURNING id`;
      patientId = patient[0]!.id;
      const service = await sql`INSERT INTO services (id, code, name_ar, name_en, default_price, currency, commission_eligible, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'SRV-V', 'خدمة زيارة', 'Visit service', 8000, 'YER', true, true, now(), now()) RETURNING id`;
      serviceId = service[0]!.id;
    } finally {
      await sql.end();
    }
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  async function insertArrivedAppointment(): Promise<string> {
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const rows = await sql`INSERT INTO appointments (id, patient_id, doctor_id, appointment_date, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${patientId}, ${doctorId}, now(), 'ARRIVED', ${adminId}, now(), now()) RETURNING id`;
      return rows[0]!.id;
    } finally {
      await sql.end();
    }
  }

  async function insertDraftVisit(): Promise<string> {
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const rows = await sql`INSERT INTO visits (id, patient_id, doctor_id, visit_date, treatment_performed, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${patientId}, ${doctorId}, now(), '', 'DRAFT', ${adminId}, now(), now()) RETURNING id`;
      return rows[0]!.id;
    } finally {
      await sql.end();
    }
  }

  function actor() {
    return { id: adminId, role: "ADMIN" as const, name: "مدير الزيارات" };
  }

  it("starts a visit atomically: draft visit + appointment IN_TREATMENT + audit in one tx", async () => {
    const { startVisitForAppointment } = await import("@/server/visits/core");
    const appointmentId = await insertArrivedAppointment();

    const result = await startVisitForAppointment(actor(), appointmentId);
    expect(result).toMatchObject({ ok: true, created: true });

    const sql = postgres(testDb.url, { max: 1 });
    try {
      const visitId = result.ok ? result.visitId : "";
      const [visit] = await sql`SELECT status, appointment_id FROM visits WHERE id = ${visitId}`;
      expect(visit!.status).toBe("DRAFT");
      expect(visit!.appointment_id).toBe(appointmentId);

      const [appointment] = await sql`SELECT status FROM appointments WHERE id = ${appointmentId}`;
      expect(appointment!.status).toBe("IN_TREATMENT");

      const audits = await sql`SELECT id FROM audit_logs WHERE entity_type = 'visit' AND entity_id = ${visitId} AND action = 'VISIT_CREATED'`;
      expect(audits).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it("starting the same appointment twice returns the SAME draft — never a second visit", async () => {
    const { startVisitForAppointment } = await import("@/server/visits/core");
    const appointmentId = await insertArrivedAppointment();

    const first = await startVisitForAppointment(actor(), appointmentId);
    expect(first).toMatchObject({ ok: true, created: true });
    const second = await startVisitForAppointment(actor(), appointmentId);
    expect(second).toMatchObject({ ok: true, created: false });
    expect(
      first.ok && second.ok ? second.visitId === first.visitId : false
    ).toBe(true);

    const sql = postgres(testDb.url, { max: 1 });
    try {
      const visits = await sql`SELECT id FROM visits WHERE appointment_id = ${appointmentId}`;
      expect(visits).toHaveLength(1);
      const audits = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'VISIT_CREATED' AND entity_id IN (SELECT id::text FROM visits WHERE appointment_id = ${appointmentId})`;
      expect(audits[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("two CONCURRENT starts create exactly one visit and one audit", async () => {
    const { startVisitForAppointment } = await import("@/server/visits/core");
    const appointmentId = await insertArrivedAppointment();

    const results = await Promise.all([
      startVisitForAppointment(actor(), appointmentId),
      startVisitForAppointment(actor(), appointmentId),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const visitIds = results.map((r) => (r.ok ? r.visitId : ""));
    expect(new Set(visitIds).size).toBe(1);

    const sql = postgres(testDb.url, { max: 1 });
    try {
      const visits = await sql`SELECT id FROM visits WHERE appointment_id = ${appointmentId}`;
      expect(visits).toHaveLength(1);
      const audits = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'VISIT_CREATED' AND entity_id = ${visitIds[0]!}`;
      expect(audits[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("completes a visit atomically: visit + appointment + commission + audit together", async () => {
    const { completeVisit } = await import("@/server/visits/core");
    const { addWorkItem } = await import("@/server/services/work-items");
    const visitId = await insertDraftVisit();

    const added = await addWorkItem(actor(), visitId, {
      serviceId,
      doctorId,
      quantity: "1",
      unitPrice: "8000.00",
      discount: null,
      currency: "YER",
      notes: null,
    });
    expect(added.ok).toBe(true);

    const result = await completeVisit(actor(), visitId, {
      doctorId,
      visitDate: new Date(),
      chiefComplaint: "شكوى",
      treatmentPerformed: "علاج منجز",
      clinicalNotes: null,
      nextVisitPlan: "متابعة",
      nextAppointmentDate: null,
    });
    expect(result).toMatchObject({
      ok: true,
      alreadyCompleted: false,
      nextAppointmentCreated: false,
    });

    const sql = postgres(testDb.url, { max: 1 });
    try {
      const [visit] = await sql`SELECT status FROM visits WHERE id = ${visitId}`;
      expect(visit!.status).toBe("COMPLETED");

      const commissions = await sql`SELECT count(*)::int AS n FROM commissions c JOIN visit_work_items w ON c.work_item_id = w.id WHERE w.visit_id = ${visitId}`;
      expect(commissions[0]!.n).toBe(1);

      const audits = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'visit' AND entity_id = ${visitId} AND action = 'VISIT_COMPLETED'`;
      expect(audits[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("completing creates the next appointment + its audit inside the same tx", async () => {
    const { completeVisit } = await import("@/server/visits/core");
    const visitId = await insertDraftVisit();
    const nextDate = new Date(Date.now() + 7 * 24 * 3600 * 1000);

    const result = await completeVisit(actor(), visitId, {
      doctorId,
      visitDate: new Date(),
      chiefComplaint: null,
      treatmentPerformed: "إكمال بموعد قادم",
      clinicalNotes: null,
      nextVisitPlan: "مراجعة",
      nextAppointmentDate: nextDate,
    });
    expect(result).toMatchObject({ ok: true, nextAppointmentCreated: true });

    const sql = postgres(testDb.url, { max: 1 });
    try {
      const nextId = result.ok ? result.nextAppointmentId! : "";
      const [appointment] = await sql`SELECT status, patient_id, doctor_id FROM appointments WHERE id = ${nextId}`;
      expect(appointment!.status).toBe("SCHEDULED");
      expect(appointment!.patient_id).toBe(patientId);

      const appointmentAudits = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'appointment' AND entity_id = ${nextId} AND action = 'APPOINTMENT_CREATED'`;
      expect(appointmentAudits[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("two CONCURRENT completions: one succeeds, the other returns alreadyCompleted — no duplicates", async () => {
    const { completeVisit } = await import("@/server/visits/core");
    const { addWorkItem } = await import("@/server/services/work-items");
    const visitId = await insertDraftVisit();
    const nextDate = new Date(Date.now() + 14 * 24 * 3600 * 1000);

    const added = await addWorkItem(actor(), visitId, {
      serviceId,
      doctorId,
      quantity: "2",
      unitPrice: "8000.00",
      discount: null,
      currency: "YER",
      notes: null,
    });
    expect(added.ok).toBe(true);

    const [first, second] = await Promise.all([
      completeVisit(actor(), visitId, {
        doctorId,
        visitDate: new Date(),
        chiefComplaint: null,
        treatmentPerformed: "إكمال متزامن ١",
        clinicalNotes: null,
        nextVisitPlan: "متابعة",
        nextAppointmentDate: nextDate,
      }),
      completeVisit(actor(), visitId, {
        doctorId,
        visitDate: new Date(),
        chiefComplaint: null,
        treatmentPerformed: "إكمال متزامن ٢",
        clinicalNotes: null,
        nextVisitPlan: "متابعة",
        nextAppointmentDate: nextDate,
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(2);
    const created = outcomes.filter((r) => r.ok && !r.alreadyCompleted);
    const alreadyDone = outcomes.filter((r) => r.ok && r.alreadyCompleted);
    expect(created).toHaveLength(1);
    expect(alreadyDone).toHaveLength(1);
    // The loser must NOT report a next appointment of its own.
    expect(alreadyDone[0]!.ok ? alreadyDone[0]!.nextAppointmentCreated : true).toBe(false);

    const sql = postgres(testDb.url, { max: 1 });
    try {
      // ONE completion audit (not two).
      const completionAudits = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'visit' AND entity_id = ${visitId} AND action = 'VISIT_COMPLETED'`;
      expect(completionAudits[0]!.n).toBe(1);

      // ONE next appointment for this doctor at that instant.
      const nextAppointments = await sql`SELECT count(*)::int AS n FROM appointments WHERE doctor_id = ${doctorId} AND appointment_date = ${nextDate.toISOString()}`;
      expect(nextAppointments[0]!.n).toBe(1);

      // ONE appointment-created audit.
      const appointmentAudits = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'APPOINTMENT_CREATED' AND metadata->>'source' = 'visit-completion' AND entity_id IN (SELECT id::text FROM appointments WHERE doctor_id = ${doctorId} AND appointment_date = ${nextDate.toISOString()})`;
      expect(appointmentAudits[0]!.n).toBe(1);

      // Commissions generated exactly once per work item.
      const commissions = await sql`SELECT count(*)::int AS n FROM commissions c JOIN visit_work_items w ON c.work_item_id = w.id WHERE w.visit_id = ${visitId}`;
      expect(commissions[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("rolls back the WHOLE completion when a later step fails (no partial writes)", async () => {
    const { completeVisit } = await import("@/server/visits/core");
    const { addWorkItem } = await import("@/server/services/work-items");
    const visitId = await insertDraftVisit();

    const added = await addWorkItem(actor(), visitId, {
      serviceId,
      doctorId,
      quantity: "1",
      unitPrice: "8000.00",
      discount: null,
      currency: "YER",
      notes: null,
    });
    expect(added.ok).toBe(true);

    // Baseline counts (tests share the same patient fixture — scope every
    // assertion to the DELTA this rolled-back transaction must not leave).
    const sql0 = postgres(testDb.url, { max: 1 });
    let scheduledBefore = 0;
    try {
      const rows = await sql0`SELECT count(*)::int AS n FROM appointments WHERE patient_id = ${patientId} AND status = 'SCHEDULED'`;
      scheduledBefore = rows[0]!.n;
    } finally {
      await sql0.end();
    }

    const result = await completeVisit(
      actor(),
      visitId,
      {
        doctorId,
        visitDate: new Date(),
        chiefComplaint: null,
        treatmentPerformed: "إكمال سيفشل",
        clinicalNotes: null,
        nextVisitPlan: null,
        nextAppointmentDate: new Date(Date.now() + 21 * 24 * 3600 * 1000),
      },
      {
        beforeNextAppointmentInsert: async () => {
          throw new Error("injected failure mid-transaction");
        },
      }
    );
    expect(result.ok).toBe(false);

    const sql = postgres(testDb.url, { max: 1 });
    try {
      // Visit unchanged.
      const [visit] = await sql`SELECT status, treatment_performed FROM visits WHERE id = ${visitId}`;
      expect(visit!.status).toBe("DRAFT");
      expect(visit!.treatment_performed).toBe("");

      // No commissions.
      const commissions = await sql`SELECT count(*)::int AS n FROM commissions c JOIN visit_work_items w ON c.work_item_id = w.id WHERE w.visit_id = ${visitId}`;
      expect(commissions[0]!.n).toBe(0);

      // No next appointment beyond the baseline.
      const next = await sql`SELECT count(*)::int AS n FROM appointments WHERE patient_id = ${patientId} AND status = 'SCHEDULED'`;
      expect(next[0]!.n).toBe(scheduledBefore);

      // No audits — the movement never happened.
      const audits = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'visit' AND entity_id = ${visitId} AND action = 'VISIT_COMPLETED'`;
      expect(audits[0]!.n).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("refuses a conflicting next appointment and writes NOTHING (in-tx conflict check)", async () => {
    const { completeVisit } = await import("@/server/visits/core");
    const visitId = await insertDraftVisit();
    const conflictDate = new Date(Date.now() + 28 * 24 * 3600 * 1000);

    // A still-active appointment at the exact same doctor+instant.
    const sql = postgres(testDb.url, { max: 1 });
    try {
      await sql`INSERT INTO appointments (id, patient_id, doctor_id, appointment_date, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${patientId}, ${doctorId}, ${conflictDate.toISOString()}, 'SCHEDULED', ${adminId}, now(), now())`;
    } finally {
      await sql.end();
    }

    const result = await completeVisit(actor(), visitId, {
      doctorId,
      visitDate: new Date(),
      chiefComplaint: null,
      treatmentPerformed: "لن يُكتب",
      clinicalNotes: null,
      nextVisitPlan: null,
      nextAppointmentDate: conflictDate,
    });
    expect(result).toEqual({ ok: false, code: "appointmentConflict" });

    const check = postgres(testDb.url, { max: 1 });
    try {
      const [visit] = await check`SELECT status, treatment_performed FROM visits WHERE id = ${visitId}`;
      expect(visit!.status).toBe("DRAFT");
      expect(visit!.treatment_performed).toBe("");

      const audits = await check`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'visit' AND entity_id = ${visitId} AND action = 'VISIT_COMPLETED'`;
      expect(audits[0]!.n).toBe(0);
    } finally {
      await check.end();
    }
  });
});
