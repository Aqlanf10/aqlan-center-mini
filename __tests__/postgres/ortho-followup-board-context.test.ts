import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";
import { validatePostgresTestTarget } from "./_safe-target";

/**
 * Real PostgreSQL regression for the read-only periodic Ortho board projection.
 * No mocks of SQL, classification, appointment writers, or referral resolution.
 *
 * The canonical guard requires an explicit loopback TEST_DATABASE_URL naming
 * aqlan_p1_test, rejects Production/Railway, and restricts URL query options.
 * Use that target only to create a fresh UUID-owned database on PostgreSQL 18.
 * Never reset the shared schema: aggregate CI already has tables there, and
 * requiring another reset flag would break its existing integration command.
 * Cleanup drains our own pool and drops only a database this suite created,
 * without FORCE. Run through the standard vitest.config.postgres.mts harness.
 */
const originalEnvironment = { ...process.env };
const database = `aqlan_ortho_followup_${randomUUID().replace(/-/g, "")}`;
const TODAY = "2026-10-05";
const START = "2026-01-01";
const ACTOR = "synthetic-followup-board";
let maintenanceUrl = "";
let created = false;
let db!: typeof import("../../lib/db");
let sequence = 0;
let orthodontist = 0;
let appointmentDoctor = 0;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query<T>(sql, params)).rows;
}

async function prepareSyntheticFixture(): Promise<void> {
  // Validate the ORIGINAL environment before constructing a connection or
  // replacing any URLs/markers. Never normalize away Production/Railway.
  const target = validatePostgresTestTarget(originalEnvironment);
  if (originalEnvironment.USE_LOCAL_DB === "true") {
    throw new Error("Ortho follow-up board proof requires real PostgreSQL, not USE_LOCAL_DB.");
  }
  if (!/^aqlan_ortho_followup_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe fixture name.");
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try {
    const { rows: [server] } = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(server.version));
    // Fresh-only: a name collision must fail, never drop or reuse existing data.
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
  } finally { await admin.end(); }
  target.testUrl.pathname = `/${database}`;
  vi.stubEnv("DATABASE_URL", target.testUrl.toString());
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false");
  vi.stubEnv("SKIP_SEED", "true");
  vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
  vi.stubEnv("TZ", "UTC");
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
}

type Service = { id: number; name: string };
const services = new Map<string, Service>();
async function service(code: string, specialty: string, legacyType: string | null): Promise<Service> {
  const name = `Synthetic appointment service: ${code}`;
  const [row] = await q<{ id: number }>(
    `INSERT INTO appointment_services (code, name_ar, specialty, legacy_type, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (code) DO UPDATE
       SET name_ar = EXCLUDED.name_ar, specialty = EXCLUDED.specialty, legacy_type = EXCLUDED.legacy_type
     RETURNING id`, [code, name, specialty, legacyType, ACTOR],
  );
  const result = { id: row.id, name };
  services.set(code, result);
  return result;
}
function catalog(code: string): Service {
  const found = services.get(code);
  if (!found) throw new Error(`Synthetic service was not prepared: ${code}`);
  return found;
}

beforeAll(async () => {
  await prepareSyntheticFixture();
  await db.ensureSchema();
  orthodontist = (await q<{ id: number }>(
    "INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic responsible orthodontist') RETURNING id",
  ))[0].id;
  appointmentDoctor = (await q<{ id: number }>(
    "INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic actual appointment doctor') RETURNING id",
  ))[0].id;
  await service("ORTHO_FOLLOW_UP", "orthodontics", "follow_up");
  await service("SYNTHETIC_ENDO", "endodontics", "endo");
  await service("SYNTHETIC_CONSULT", "consultation", "consultation");
  await service("SYNTHETIC_PERIODIC", "orthodontics", "follow_up");
  await service("SYNTHETIC_ORTHO_UNKNOWN", "orthodontics", null);
  await service("SYNTHETIC_BAD_SPECIALTY", "", "follow_up");
  await service("SYNTHETIC_BAD_LEGACY", "orthodontics", "unrecognized_legacy_type");
  // Historic generic mappings must not turn specific nonperiodic work into a
  // periodic follow-up, even when BOTH stored legacy fields say follow_up.
  for (const code of ["ORTHO_START", "ORTHO_DEBOND", "BRACKET_REBOND", "BRACKET_BONDING", "ORTHO_WIRE_CHANGE"]) {
    await service(code, "orthodontics", "follow_up");
  }
}, 180_000);

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  try { await db?.resetPoolForTesting(); }
  catch (error) { cleanupErrors.push(error); }
  try { vi.unstubAllEnvs(); }
  catch (error) { cleanupErrors.push(error); }
  if (created) {
    let admin: Client | undefined;
    try {
      admin = new Client({ connectionString: maintenanceUrl, ssl: false });
      await admin.connect();
      const deadline = performance.now() + 8_000;
      while (true) {
        const { rows: [row] } = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [database],
        );
        if (row.n === 0) break;
        if (performance.now() >= deadline) throw new Error("Owned Ortho follow-up fixture connections did not drain.");
        await delay(20);
      }
      // No FORCE, schema reset, wildcard deletion, or other-session termination.
      await admin.query(`DROP DATABASE ${database}`);
    } catch (error) { cleanupErrors.push(error); }
    finally {
      try { await admin?.end(); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  // Vitest retains earlier setup/test failures independently; this hook never
  // catches them. Report every cleanup failure without a finally throw masking
  // the first reset, environment, connection, drain, drop, or end failure.
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Owned Ortho follow-up fixture cleanup failed.");
});

async function patient(): Promise<number> {
  const key = `SYNTHETIC-ORTHO-BOARD-${++sequence}`;
  return (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone, primary_doctor_id)
     VALUES ($1, $2, NULL, $3) RETURNING id`, [key, `Synthetic patient ${sequence}`, orthodontist],
  ))[0].id;
}

async function orthoCase(patientId: number, options: {
  status?: "active" | "retention" | "completed" | "discontinued";
  startDate?: string;
  planId?: number | null;
} = {}): Promise<number> {
  return (await q<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, status, start_date, plan_id, responsible_doctor_id, created_by)
     VALUES ($1, $2, $3::date, $4, $5, $6) RETURNING id`,
    [patientId, options.status ?? "active", options.startDate ?? START, options.planId ?? null, orthodontist, ACTOR],
  ))[0].id;
}

async function fixture(options: Parameters<typeof orthoCase>[1] = {}) {
  const patientId = await patient();
  return { patientId, caseId: await orthoCase(patientId, options) };
}

async function clinicalCase(patientId: number, orthoCaseId: number | null, specialty = "orthodontics"): Promise<number> {
  return (await q<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, ortho_case_id, specialty, title, started_on, created_by)
     VALUES ($1, $2, $3, 'Synthetic clinical case', $4::date, $5) RETURNING id`,
    [patientId, orthoCaseId, specialty, START, ACTOR],
  ))[0].id;
}

async function referral(patientId: number, caseId: number | null, specialty = "other"): Promise<number> {
  // FK-valid inconsistent links below intentionally reproduce legacy data.
  // No triggers or constraints are disabled to create these synthetic records.
  return (await q<{ id: number }>(
    `INSERT INTO patient_referrals (patient_id, case_id, to_name, to_specialty, reason, created_by)
     VALUES ($1, $2, 'Synthetic referral receiver', $3, 'Synthetic board context', $4) RETURNING id`,
    [patientId, caseId, specialty, ACTOR],
  ))[0].id;
}

type AppointmentOptions = {
  date?: string;
  time?: string;
  status?: "booked" | "arrived" | "done" | "cancelled" | "no_show";
  serviceId?: number | null;
  appointmentType?: string | null;
  doctorId?: number | null;
  referralId?: number | null;
  plannedVisitId?: number | null;
};
async function appointment(patientId: number, options: AppointmentOptions = {}): Promise<number> {
  return (await q<{ id: number }>(
    `INSERT INTO appointments
       (patient_id, scheduled_date, scheduled_time, status, service_id, appointment_type,
        doctor_id, referral_id, planned_visit_id, note)
     VALUES ($1, $2::date, $3::time, $4, $5, $6, $7, $8, $9, 'Synthetic board fixture') RETURNING id`,
    [patientId, options.date ?? "2026-10-08", options.time ?? "10:30", options.status ?? "booked",
      options.serviceId === undefined ? catalog("ORTHO_FOLLOW_UP").id : options.serviceId,
      options.appointmentType === undefined ? "follow_up" : options.appointmentType,
      options.doctorId === undefined ? appointmentDoctor : options.doctorId,
      options.referralId ?? null, options.plannedVisitId ?? null],
  ))[0].id;
}

async function boardRow(caseId: number) {
  const matches = (await db.orthoFollowupBoard(TODAY)).filter((row) => row.caseId === caseId);
  expect(matches, "one row per active/retention Ortho case, regardless of appointment/link count").toHaveLength(1);
  expect(matches[0].bookingContext.verified).toBe(true);
  return matches[0];
}

describe("classify every real booking before choosing the nearest periodic follow-up", () => {
  it("retains an earlier unrelated booking and selects the later identified periodic appointment with its real details", async () => {
    const target = await fixture();
    const unrelated = await appointment(target.patientId, {
      date: "2026-10-06", time: "09:05", appointmentType: "endo", serviceId: catalog("SYNTHETIC_ENDO").id,
      doctorId: orthodontist,
    });
    const relevant = await appointment(target.patientId, { date: "2026-10-20", time: "14:25" });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toEqual({
      id: relevant, date: "2026-10-20", time: "14:25", status: "booked",
      serviceName: catalog("ORTHO_FOLLOW_UP").name, doctorName: "Synthetic actual appointment doctor",
      appointmentType: "follow_up", matchBasis: "designated_service", reason: "designated_periodic_service",
    });
    expect(row.bookingContext).toEqual({
      verified: true, pastUnresolvedAppointment: null, reviewAppointments: [],
      otherAppointments: [{
        id: unrelated, date: "2026-10-06", time: "09:05", status: "booked",
        serviceName: catalog("SYNTHETIC_ENDO").name, doctorName: "Synthetic responsible orthodontist",
        appointmentType: "endo", matchBasis: null, reason: "contrary_service_specialty",
      }],
    });
  });

  it("never lets only-unrelated bookings close the follow-up gap, even with the responsible doctor", async () => {
    const target = await fixture();
    const endo = await appointment(target.patientId, {
      date: "2026-10-06", serviceId: catalog("SYNTHETIC_ENDO").id, appointmentType: "endo", doctorId: orthodontist,
    });
    const consult = await appointment(target.patientId, {
      date: "2026-10-07", serviceId: catalog("SYNTHETIC_CONSULT").id, appointmentType: "consultation",
    });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.pastUnresolvedAppointment).toBeNull();
    expect(row.bookingContext.reviewAppointments).toEqual([]);
    expect(row.bookingContext.otherAppointments.map((item) => item.id)).toEqual([endo, consult]);
  });

  it.each(["ORTHO_START", "ORTHO_DEBOND", "BRACKET_REBOND", "BRACKET_BONDING", "ORTHO_WIRE_CHANGE"])(
    "keeps %s for review rather than treating it as periodic care",
    async (code) => {
      const target = await fixture();
      const id = await appointment(target.patientId, { serviceId: catalog(code).id });
      const row = await boardRow(target.caseId);
      expect(row.nextAppointment).toBeNull();
      expect(row.bookingContext.reviewAppointments).toEqual([expect.objectContaining({
        id, serviceName: catalog(code).name, appointmentType: "follow_up", matchBasis: null, reason: "other_ortho_service",
      })]);
      expect(row.bookingContext.otherAppointments).toEqual([]);
    },
  );

  it("accepts an explicit custom periodic mapping but not Ortho specialty alone", async () => {
    const target = await fixture();
    const ambiguous = await appointment(target.patientId, {
      date: "2026-10-06", serviceId: catalog("SYNTHETIC_ORTHO_UNKNOWN").id, appointmentType: null,
    });
    const mapped = await appointment(target.patientId, { serviceId: catalog("SYNTHETIC_PERIODIC").id });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toMatchObject({
      id: mapped, serviceName: catalog("SYNTHETIC_PERIODIC").name,
      matchBasis: "designated_service", reason: "designated_periodic_service",
    });
    expect(row.bookingContext.reviewAppointments).toEqual([expect.objectContaining({
      id: ambiguous, reason: "unclassified_ortho_service", matchBasis: null,
    })]);
  });

  it("accepts a genuinely service-less legacy follow_up without inventing service or doctor names", async () => {
    const target = await fixture();
    const id = await appointment(target.patientId, { serviceId: null, doctorId: null });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toEqual({
      id, date: "2026-10-08", time: "10:30", status: "booked", serviceName: null, doctorName: null,
      appointmentType: "follow_up", matchBasis: "legacy_type", reason: "service_less_legacy",
    });
    expect(row.bookingContext.reviewAppointments).toEqual([]);
  });

  it("preserves incomplete/contradictory metadata for review instead of losing rows through inner joins", async () => {
    const target = await fixture();
    const untyped = await appointment(target.patientId, { serviceId: null, appointmentType: null, doctorId: null });
    const badSpecialty = await appointment(target.patientId, { serviceId: catalog("SYNTHETIC_BAD_SPECIALTY").id });
    const badLegacy = await appointment(target.patientId, { serviceId: catalog("SYNTHETIC_BAD_LEGACY").id });
    const contrary = await appointment(target.patientId, { serviceId: catalog("SYNTHETIC_ENDO").id });
    const conflictingType = await appointment(target.patientId, { appointmentType: "consultation" });
    const otherLegacy = await appointment(target.patientId, { serviceId: null, appointmentType: "endo" });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.reviewAppointments.map(({ id, reason, matchBasis }) => ({ id, reason, matchBasis }))).toEqual([
      { id: untyped, reason: "untyped_legacy", matchBasis: null },
      { id: badSpecialty, reason: "unknown_service_identifier", matchBasis: null },
      { id: badLegacy, reason: "unknown_service_identifier", matchBasis: null },
      { id: contrary, reason: "contrary_service_specialty", matchBasis: null },
      { id: conflictingType, reason: "conflicting_periodic_type", matchBasis: null },
    ]);
    expect(row.bookingContext.reviewAppointments[0]).toMatchObject({ serviceName: null, doctorName: null, appointmentType: null });
    expect(row.bookingContext.otherAppointments).toEqual([expect.objectContaining({ id: otherLegacy, reason: "different_legacy_type" })]);
  });
});

describe("real referral/case/Ortho bridge joins preserve patient boundaries", () => {
  it("accepts an explicitly matching same-patient current-case referral", async () => {
    const target = await fixture();
    const bridge = await clinicalCase(target.patientId, target.caseId);
    const link = await referral(target.patientId, bridge);
    const id = await appointment(target.patientId, { referralId: link });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toMatchObject({ id, matchBasis: "designated_service", reason: "designated_periodic_service" });
    expect(row.bookingContext.reviewAppointments).toEqual([]);
  });

  it("reviews same-patient foreign-specialty cases, contrary referrals and missing case metadata", async () => {
    const target = await fixture();
    const bridge = await clinicalCase(target.patientId, target.caseId);
    const endo = await clinicalCase(target.patientId, null, "endodontics");
    const otherCase = await appointment(target.patientId, { referralId: await referral(target.patientId, endo) });
    const contrarySpecialty = await appointment(target.patientId, { referralId: await referral(target.patientId, bridge, "endodontics") });
    const missingCase = await appointment(target.patientId, { referralId: await referral(target.patientId, null) });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.reviewAppointments.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: otherCase, reason: "different_referral_case" },
      { id: contrarySpecialty, reason: "contrary_referral_specialty" },
      { id: missingCase, reason: "referral_without_case" },
    ]);
  });

  it("retains foreign-patient referral and clinical-case links as unresolved, never as service-less confirmations", async () => {
    const target = await fixture();
    const foreign = await fixture();
    const ownBridge = await clinicalCase(target.patientId, target.caseId);
    const foreignBridge = await clinicalCase(foreign.patientId, foreign.caseId);
    // All FKs exist, but each link violates the same-patient relationship.
    const foreignReferral = await appointment(target.patientId, {
      serviceId: null, referralId: await referral(foreign.patientId, ownBridge),
    });
    const foreignClinicalCase = await appointment(target.patientId, {
      referralId: await referral(target.patientId, foreignBridge),
    });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.reviewAppointments.map((item) => item.id)).toEqual([foreignReferral, foreignClinicalCase]);
    expect(row.bookingContext.reviewAppointments[0]).toMatchObject({ matchBasis: null, reason: "unresolved_referral" });
    expect(row.bookingContext.reviewAppointments[1]).toMatchObject({ matchBasis: null, reason: "referral_patient_mismatch" });
    expect((await boardRow(foreign.caseId)).nextAppointment).toBeNull();
  });

  it("does not trust a clinical bridge whose Ortho case belongs to another patient", async () => {
    const target = await fixture();
    const foreign = await fixture();
    const wrongBridge = await clinicalCase(target.patientId, foreign.caseId);
    const id = await appointment(target.patientId, { referralId: await referral(target.patientId, wrongBridge) });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.reviewAppointments).toEqual([expect.objectContaining({
      id, matchBasis: null, reason: "unresolved_referral_case",
    })]);
    expect((await boardRow(foreign.caseId)).nextAppointment).toBeNull();
  });

  it("does not treat a foreign-patient clinical bridge to the current Ortho case as a matching case", async () => {
    const target = await fixture();
    const foreignPatient = await patient();
    const wrongBridge = await clinicalCase(foreignPatient, target.caseId);
    const id = await appointment(target.patientId, { referralId: await referral(target.patientId, wrongBridge) });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.reviewAppointments).toEqual([expect.objectContaining({
      id, matchBasis: null, reason: "referral_patient_mismatch",
    })]);
  });

  it("keeps old-case bookings and pre-case legacy bookings separate from the current case", async () => {
    const target = await fixture({ startDate: "2026-10-01" });
    const oldCase = await orthoCase(target.patientId, { status: "completed", startDate: "2024-01-01" });
    await clinicalCase(target.patientId, target.caseId);
    const oldBridge = await clinicalCase(target.patientId, oldCase);
    const beforeStart = await appointment(target.patientId, { date: "2026-09-30", serviceId: null });
    const oldLinked = await appointment(target.patientId, {
      date: "2026-10-06", referralId: await referral(target.patientId, oldBridge),
    });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.pastUnresolvedAppointment).toBeNull();
    expect(row.bookingContext.reviewAppointments.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: beforeStart, reason: "before_case_start" },
      { id: oldLinked, reason: "different_referral_case" },
    ]);
    expect((await db.orthoFollowupBoard(TODAY)).some((item) => item.caseId === oldCase)).toBe(false);
  });

  it("does not infer periodic case linkage from a shared master plan or planned visit", async () => {
    const patientId = await patient();
    const [plan] = await q<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status)
       VALUES ($1, 'Synthetic mixed-specialty plan', 0, 'YER', 'active') RETURNING id`, [patientId],
    );
    const caseId = await orthoCase(patientId, { planId: plan.id });
    const [planned] = await q<{ id: number }>(
      `INSERT INTO planned_visits (patient_id, plan_id, sequence, title, doctor_id)
       VALUES ($1, $2, 1, 'Synthetic mixed visit', $3) RETURNING id`, [patientId, plan.id, orthodontist],
    );
    const id = await appointment(patientId, { plannedVisitId: planned.id, doctorId: orthodontist });
    const row = await boardRow(caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.reviewAppointments).toEqual([expect.objectContaining({
      id, reason: "planned_visit_requires_review", matchBasis: null,
    })]);
  });
});

describe("chronology, no-show history and case cardinality", () => {
  it("selects today/future by date, time and ID, while separating the latest unresolved past booking", async () => {
    const target = await fixture();
    await appointment(target.patientId, { date: "2026-10-06", time: "00:05" });
    await appointment(target.patientId, { date: TODAY, time: "14:00" });
    const next = await appointment(target.patientId, { date: TODAY, time: "08:05", status: "arrived" });
    await appointment(target.patientId, { date: TODAY, time: "08:05" });
    await appointment(target.patientId, { date: "2026-09-01", time: "23:55" });
    await appointment(target.patientId, { date: "2026-10-04", time: "12:30" });
    const past = await appointment(target.patientId, { date: "2026-10-04", time: "12:30", status: "arrived" });
    await appointment(target.patientId, { date: "2026-10-04", time: "08:00" });
    const first = await boardRow(target.caseId);
    expect(first.nextAppointment).toMatchObject({ id: next, date: TODAY, time: "08:05", status: "arrived" });
    expect(first.bookingContext.pastUnresolvedAppointment).toEqual({
      id: past, date: "2026-10-04", time: "12:30", status: "arrived",
      serviceName: catalog("ORTHO_FOLLOW_UP").name, doctorName: "Synthetic actual appointment doctor",
      appointmentType: "follow_up", matchBasis: "designated_service", reason: "designated_periodic_service",
    });
    expect(await boardRow(target.caseId)).toEqual(first);
  });

  it("never moves a past unresolved booking into nextAppointment when no future periodic booking exists", async () => {
    const target = await fixture();
    const past = await appointment(target.patientId, { date: "2026-10-04", serviceId: null });
    const unrelated = await appointment(target.patientId, {
      serviceId: catalog("SYNTHETIC_ENDO").id, appointmentType: "endo",
    });
    const row = await boardRow(target.caseId);
    expect(row.nextAppointment).toBeNull();
    expect(row.bookingContext.pastUnresolvedAppointment).toMatchObject({ id: past, matchBasis: "legacy_type" });
    expect(row.bookingContext.otherAppointments.map((item) => item.id)).toEqual([unrelated]);
  });

  it("keeps any historical patient no-show despite newer completed, cancelled and future bookings", async () => {
    const target = await fixture();
    await appointment(target.patientId, {
      date: "2025-12-01", status: "no_show", serviceId: catalog("SYNTHETIC_ENDO").id, appointmentType: "endo",
    });
    await appointment(target.patientId, { date: "2026-10-03", status: "done" });
    await appointment(target.patientId, { date: "2026-10-06", status: "cancelled" });
    const next = await appointment(target.patientId);
    const row = await boardRow(target.caseId);
    expect(row.lastWasNoShow).toBe(true);
    expect(row.nextAppointment?.id).toBe(next);
    expect(row.bookingContext).toEqual({ verified: true, pastUnresolvedAppointment: null, reviewAppointments: [], otherAppointments: [] });
    const unaffected = await fixture();
    expect((await boardRow(unaffected.caseId)).lastWasNoShow).toBe(false);
  });

  it("returns one row per active/retention case, excludes closed cases, and keeps latest adjustment attribution", async () => {
    const active = await fixture();
    const retention = await fixture({ status: "retention" });
    const closed = await fixture({ status: "completed" });
    const discontinued = await fixture({ status: "discontinued" });
    const old = await orthoCase(active.patientId, { status: "completed" });
    await clinicalCase(active.patientId, active.caseId);
    await clinicalCase(active.patientId, old);
    await clinicalCase(active.patientId, null, "endodontics");
    for (const target of [active, retention, closed, discontinued]) {
      await appointment(target.patientId);
      await appointment(target.patientId, { date: "2026-10-09" });
    }
    for (const [caseId, date, weeks, wire] of [
      [active.caseId, "2026-09-30", 3, "older same-day wire"],
      [active.caseId, "2026-09-30", 6, "latest same-day wire"],
      [old, "2026-10-04", 9, "closed-case wire"],
    ] as const) {
      await q(
        `INSERT INTO ortho_adjustments (case_id, done_on, next_weeks, upper_wire, recorded_by)
         VALUES ($1, $2::date, $3, $4, $5)`, [caseId, date, weeks, wire, ACTOR],
      );
    }
    const patientIds = [active, retention, closed, discontinued].map((target) => target.patientId);
    const rows = (await db.orthoFollowupBoard(TODAY)).filter((row) => patientIds.includes(row.patientId));
    expect(rows.map((row) => row.caseId).sort((a, b) => a - b)).toEqual([active.caseId, retention.caseId].sort((a, b) => a - b));
    expect(rows.find((row) => row.caseId === active.caseId)).toMatchObject({
      status: "active", lastAdjustmentDate: "2026-09-30", nextWeeks: 6, upperWire: "latest same-day wire",
    });
    expect(rows.find((row) => row.caseId === retention.caseId)).toMatchObject({
      status: "retention", lastAdjustmentDate: null, nextWeeks: 4, bookingContext: { verified: true },
    });
  });
});

/** Exact contents of every public table plus sequence positions: catches writes
 * to bookings, histories, reminders, referrals, clinical and financial records,
 * including a sequence consumed by a rolled-back attempted insert. */
async function databaseSnapshot() {
  const tables = await q<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const contents: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    const quoted = `"${tablename.replaceAll('"', '""')}"`;
    const [row] = await q<{ contents: unknown }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) AS contents
         FROM public.${quoted} AS r`,
    );
    contents[tablename] = row.contents;
  }
  const sequences = await q(
    `SELECT sequencename, last_value::text FROM pg_sequences
      WHERE schemaname = 'public' ORDER BY sequencename`,
  );
  return { contents, sequences };
}

it("repeated board reads leave every stored row and sequence untouched, including inconsistent legacy links", async () => {
  const target = await fixture();
  const foreign = await fixture();
  const bridge = await clinicalCase(foreign.patientId, foreign.caseId);
  await appointment(target.patientId, { referralId: await referral(target.patientId, bridge) });
  await appointment(target.patientId, { date: "2026-10-04", serviceId: null });
  await appointment(target.patientId, { date: "2026-10-09" });
  // Schema initialization and every fixture write have finished before the
  // baseline. The board may display uncertainty, never repair or rebook it.
  const before = await databaseSnapshot();
  const first = await db.orthoFollowupBoard(TODAY);
  const second = await db.orthoFollowupBoard(TODAY);
  expect(second).toEqual(first);
  expect(await databaseSnapshot()).toEqual(before);
});
