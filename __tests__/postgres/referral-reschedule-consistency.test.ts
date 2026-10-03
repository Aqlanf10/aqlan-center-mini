import { randomUUID } from "node:crypto";
import type { AppointmentReadScope } from "../../lib/appointment-read-scope";
import type { Referral } from "../../lib/referrals";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertPostgres18VersionNum,
} from "../../scripts/verify-schema-ownership";
import { validatePostgresTestTarget } from "./_safe-target";

/**
 * A referral appointment belongs to the receiving doctor, both when first
 * linked and when rescheduled through the ordinary reception booking writer.
 * Only synthetic fixtures in a new, guarded, loopback PostgreSQL 18 database.
 * The real booking, referral, rescheduling and arrival writers are not mocked.
 */
const database = `aqlan_referral_move_${randomUUID().replace(/-/g, "")}`;
let maintenanceUrl: string;
let created = false;
let db: typeof import("../../lib/db");
let booking: typeof import("../../lib/book-appointment");
let appointmentRoute: typeof import("../../app/api/appointments/[id]/route");
let referringDoctor = 0;
let receivingDoctor = 0;
let otherDoctor = 0;
let sequence = 0;

const reception = { username: "synthetic-reception", role: "reception" as const, channel: "ui" as const };

// Supply only the request-session boundary. Resource authorization, request
// parsing and every application/SQL writer remain real. This is an ordinary
// authorized reception flow, not an authentication or access-control probe.
vi.mock("../../lib/session", () => ({
  requireSession: async () => ({ userId: 1, username: "synthetic-reception", role: "reception", expiresAt: 4_000_000_000 }),
}));

async function q<T = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query(sql, parameters)).rows as T[];
}

beforeAll(async () => {
  // Validate before changing environment or creating/dropping any database.
  const target = validatePostgresTestTarget();
  if (!/^aqlan_referral_move_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe fixture database name.");
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try {
    const { rows: [version] } = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    assertPostgres18VersionNum(version.version);
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
  } finally {
    await admin.end();
  }
  target.testUrl.pathname = `/${database}`;
  vi.stubEnv("DATABASE_URL", target.testUrl.toString());
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false");
  vi.stubEnv("SKIP_SEED", "true");
  db = await import("../../lib/db");
  booking = await import("../../lib/book-appointment");
  appointmentRoute = await import("../../app/api/appointments/[id]/route");
  await db.resetPoolForTesting();
  await db.ensureSchema();
  await db.saveSettings({ "clinic.chairs": "4", "clinic.day_start": "08:00", "clinic.day_end": "20:00" });
  db.invalidateSettingsCache();
  const doctor = async (name: string) => (await q<{ id: number }>(
    "INSERT INTO parties (kind, name) VALUES ('doctor', $1) RETURNING id", [name],
  ))[0].id;
  referringDoctor = await doctor("Synthetic referring doctor");
  receivingDoctor = await doctor("Synthetic receiving doctor");
  otherDoctor = await doctor("Synthetic other doctor");
});

afterAll(async () => {
  try {
    await db?.resetPoolForTesting();
  } finally {
    vi.unstubAllEnvs();
    if (created) {
      const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
      await admin.connect();
      try { await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  }
});

type ReferralAction = "accept" | "schedule" | "complete" | "acknowledge";
function step(referralId: number, action: ReferralAction, appointmentId: number | null = null) {
  return db.transitionInternalReferral({
    id: referralId, action, appointmentId, note: null,
    procedurePerformed: action === "complete" ? "Synthetic completed treatment" : null,
    followupRequired: null, mayReturn: null,
    actor: action === "schedule" ? reception.username : "synthetic-doctor",
    actorRole: action === "schedule" ? "reception" : "doctor",
  });
}

async function book(patientId: number, date: string, time: string, doctorId: number | null) {
  const result = await booking.bookAppointment({ patientId, date, time, doctorId, durationMinutes: 30 }, reception);
  expect(result.ok, "Synthetic appointment should book without an override").toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return Number(result.appointment.id);
}

async function fixture(options: { linked?: boolean; today?: boolean; time?: string } = {}) {
  const seq = ++sequence;
  const [patient] = await q<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id",
    [`SYN-REF-MOVE-${seq}`, `Synthetic referral patient ${seq}`, referringDoctor],
  );
  const [dates] = await q<{ date: string; next_date: string }>(
    `SELECT ((NOW() AT TIME ZONE $1)::date + $2::int)::text AS date,
            ((NOW() AT TIME ZONE $1)::date + $2::int + 1)::text AS next_date`,
    [db.CLINIC_TIME_ZONE, options.today ? 0 : seq * 3],
  );
  const clinicalCase = await db.createClinicalCase({
    patientId: patient.id, specialty: "endodontics", title: "Synthetic referral case",
    site: "21", problem: null, responsiblePartyId: receivingDoctor, orthoCaseId: null,
    actor: "synthetic-referrer",
  });
  if (!clinicalCase.ok) throw new Error(clinicalCase.reason);
  const referral = await db.createInternalReferral({
    patientId: patient.id, doctorPartyId: referringDoctor, toPartyId: receivingDoctor,
    toSpecialty: "endodontics", reason: "Synthetic referral treatment", teeth: "21", urgency: "routine",
    caseId: clinicalCase.case.id!, blocksCaseId: null, planItemId: null, requestedServiceId: null,
    actor: "synthetic-referrer", actorRole: "doctor",
  });
  if (!referral.ok) throw new Error(referral.reason);
  expect(await step(referral.referral.id, "accept")).toMatchObject({ ok: true });
  const time = options.time ?? "09:00";
  const appointmentId = await book(patient.id, dates.date, time, receivingDoctor);
  if (options.linked !== false) {
    expect(await step(referral.referral.id, "schedule", appointmentId)).toMatchObject({ ok: true });
  }
  return {
    patientId: patient.id, appointmentId, referralId: referral.referral.id,
    caseId: clinicalCase.case.id!, date: dates.date, nextDate: dates.next_date, time,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function patchReschedule(f: Fixture, doctor: "omitted" | "unchanged" | "other" | "none") {
  return appointmentRoute.PATCH(new Request(`http://localhost/api/appointments/${f.appointmentId}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "reschedule", date: f.nextDate, time: "11:00", reason: "Synthetic reception request",
      ...(doctor === "omitted" ? {} : { doctorId: doctor === "unchanged" ? receivingDoctor : doctor === "other" ? otherDoctor : null }),
    }),
  }), { params: Promise.resolve({ id: String(f.appointmentId) }) });
}

async function snapshot(f: Fixture) {
  return {
    appointment: (await q<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(a) AS row FROM appointments a WHERE id = $1", [f.appointmentId],
    ))[0],
    referral: (await q("SELECT to_jsonb(r) AS row FROM patient_referrals r WHERE id = $1", [f.referralId]))[0],
    visits: await q("SELECT to_jsonb(v) AS row FROM visits v WHERE patient_id = $1 ORDER BY id", [f.patientId]),
    audit: await q(
      `SELECT to_jsonb(a) AS row FROM audit_log a
       WHERE (entity = 'appointment' AND entity_id = $1) OR (entity = 'patient' AND entity_id = $2)
       ORDER BY id`, [String(f.appointmentId), String(f.patientId)],
    ),
  };
}

/** Observe an actual PostgreSQL wait edge, rather than guessing that an
 * application request has reached its lock after an arbitrary sleep. The small
 * polling interval only yields between catalog observations; it is not proof. */
async function waitForBlockedWriter(blockerPid: number, queryFragment: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  let observed: { pid: number; query: string; blockers: number[] }[] = [];
  do {
    observed = await q<{ pid: number; query: string; blockers: number[] }>(
      `SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
    );
    const matching = observed.filter((row) => row.blockers.includes(blockerPid) && row.query.includes(queryFragment));
    if (matching.length === 1) return matching[0].pid;
    if (matching.length > 1) throw new Error("Ambiguous PostgreSQL writer wait edge.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Expected writer blocked by PID ${blockerPid}: ${queryFragment}; observed ${JSON.stringify(observed)}`);
}

async function concurrentLinkAndMove(f: Fixture, doctorId: number | null, first: "link" | "move") {
  const gate = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  let linking: ReturnType<typeof step> | undefined;
  let moving: ReturnType<typeof booking.rescheduleAppointment> | undefined;
  const startLink = () => {
    linking = step(f.referralId, "schedule", f.appointmentId);
    void linking.catch(() => {}); // Both outcomes are awaited after releasing the gate.
  };
  const startMove = () => {
    moving = booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.nextDate, time: "11:00", doctorId,
      reason: "Synthetic concurrent doctor reassignment",
    }, reception);
    void moving.catch(() => {});
  };
  await gate.connect();
  try {
    await gate.query("BEGIN");
    const { rows: [backend] } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    if (first === "link") {
      // The real scheduling writer locks appointments first, then this referral.
      // Holding only the referral therefore parks it AFTER its appointment lock.
      await gate.query("SELECT id FROM patient_referrals WHERE id = $1 FOR UPDATE", [f.referralId]);
      startLink();
      const linkerPid = await waitForBlockedWriter(backend.pid, "FROM patient_referrals WHERE id = $1 FOR UPDATE");
      startMove();
      // Plain initial reads see the still-unlinked appointment. The move's
      // appointment lock must wait behind the linker before linking may commit.
      await waitForBlockedWriter(linkerPid, "appointments");
    } else {
      await gate.query("SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [f.appointmentId]);
      startMove();
      const moverPid = await waitForBlockedWriter(backend.pid, "appointments");
      startLink();
      // PostgreSQL reports the queued move as a blocker of the later link. This
      // proves queue order before the coordinator releases the appointment.
      await waitForBlockedWriter(moverPid, "SELECT id FROM appointments WHERE id = $1 OR referral_id = $2");
    }
    expect(await q("SELECT doctor_id, referral_id FROM appointments WHERE id = $1", [f.appointmentId]))
      .toEqual([{ doctor_id: receivingDoctor, referral_id: null }]);
  } finally {
    // The coordinator never writes fixture data and never requests the other
    // row lock. Always release it before draining either application operation.
    try { await gate.query("ROLLBACK"); }
    finally {
      try { await gate.end(); }
      finally { await Promise.allSettled([linking, moving]); }
    }
  }
  if (!linking || !moving) throw new Error("Both application writers must have started.");
  return Promise.all([linking, moving]);
}

describe("internal-referral rescheduling consistency", () => {
  it.each(["other", "none"] as const)("initial linking already rejects a %s receiving doctor", async (doctor) => {
    const f = await fixture({ linked: false });
    const unlinked = await book(f.patientId, f.nextDate, "11:00", doctor === "other" ? otherDoctor : null);
    expect(await step(f.referralId, "schedule", unlinked)).toEqual({ ok: false, reason: "bad_appointment" });
    expect(await db.getReferral(f.referralId)).toMatchObject({ workflowState: "accepted", appointmentId: null });
    expect(await q("SELECT referral_id FROM appointments WHERE id = $1", [unlinked])).toEqual([{ referral_id: null }]);
  });

  it.each(["omitted", "unchanged"] as const)("time changes with the doctor %s preserve the referral", async (doctor) => {
    const f = await fixture();
    const before = await snapshot(f);
    const result = await booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.nextDate, time: "11:00", reason: "Synthetic patient request",
      ...(doctor === "unchanged" ? { doctorId: receivingDoctor } : {}),
    }, reception);
    expect(result).toMatchObject({ ok: true, appointment: { doctorId: receivingDoctor, scheduledDate: f.nextDate } });
    expect(await q("SELECT doctor_id, referral_id FROM appointments WHERE id = $1", [f.appointmentId]))
      .toEqual([{ doctor_id: receivingDoctor, referral_id: f.referralId }]);
    expect((await snapshot(f)).referral).toEqual(before.referral);
    expect(await db.getReferral(f.referralId)).toMatchObject({ workflowState: "scheduled", appointmentId: f.appointmentId });
  });

  it.each(["other", "none"] as const)("unlinked appointments may be reassigned to %s", async (doctor) => {
    const f = await fixture({ linked: false });
    const doctorId = doctor === "other" ? otherDoctor : null;
    expect(await booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.nextDate, time: "11:00", doctorId, reason: "Synthetic reassignment",
    }, reception)).toMatchObject({ ok: true, appointment: { doctorId } });
    expect(await q("SELECT referral_id FROM appointments WHERE id = $1", [f.appointmentId])).toEqual([{ referral_id: null }]);
  });

  it.each(["other", "none"] as const)("rejects linked appointment reassignment to %s and preserves every row", async (doctor) => {
    const f = await fixture();
    expect(await db.markReminderSent(f.appointmentId)).toBe(true);
    const before = await snapshot(f);
    const result = await booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.nextDate, time: "11:00",
      doctorId: doctor === "other" ? otherDoctor : null, reason: "Synthetic reassignment",
    }, reception);
    expect.soft(result, "The same receiver rule used at initial linking must hold during rescheduling")
      .toMatchObject({ ok: false, status: 409 });
    expect(await snapshot(f), "Refusal must preserve appointment, referral, visits and audit rows").toEqual(before);
  });

  it.each(["omitted", "unchanged"] as const)("ordinary reception PATCH accepts a time change with doctor %s", async (doctor) => {
    const f = await fixture();
    const response = await patchReschedule(f, doctor);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, appointment: { doctorId: receivingDoctor } });
    expect(await q("SELECT referral_id FROM appointments WHERE id = $1", [f.appointmentId])).toEqual([{ referral_id: f.referralId }]);
  });

  it.each(["other", "none"] as const)("ordinary reception PATCH rejects linked doctor reassignment to %s atomically", async (doctor) => {
    const f = await fixture();
    expect(await db.markReminderSent(f.appointmentId)).toBe(true);
    const before = await snapshot(f);
    const response = await patchReschedule(f, doctor);
    expect.soft(response.status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["other", "none"] as const)("the transactional move writer rejects a linked doctor change to %s", async (doctor) => {
    const f = await fixture();
    const before = await snapshot(f);
    const result = await db.writeAppointmentAcrossDays({
      fromDate: f.date, toDate: f.nextDate, judge: () => ({ ok: true as const }),
      commit: (client) => db.moveAppointmentOnClient(client, {
        id: f.appointmentId, fromDate: f.date, fromTime: f.time, toDate: f.nextDate, toTime: "11:00",
        durationMinutes: 30, serviceId: null, appointmentType: null,
        bufferBeforeMinutes: 0, bufferAfterMinutes: 0, occupiesChair: true, chairNo: null,
        doctorId: doctor === "other" ? otherDoctor : null,
      }),
    });
    expect.soft(result).toEqual({ ok: true, value: null });
    expect(await snapshot(f)).toEqual(before);
  });

  it("arrival after a refused doctor change retains the receiving doctor and the referral case", async () => {
    const f = await fixture({ today: true, time: "09:00" });
    const result = await booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.date, time: "10:00",
      doctorId: otherDoctor, reason: "Synthetic reassignment before arrival",
    }, reception);
    expect.soft(result).toMatchObject({ ok: false, status: 409 });
    expect(await db.arriveAppointment(f.appointmentId, { actor: reception.username, actorRole: reception.role })).toBe(true);
    expect(await db.getReferral(f.referralId)).toMatchObject({ workflowState: "arrived" });
    expect(await q("SELECT doctor_id, case_id FROM visits WHERE appointment_id = $1", [f.appointmentId]))
      .toEqual([{ doctor_id: receivingDoctor, case_id: f.caseId }]);
  });

  it("a legitimate time-only move still arrives in the receiving doctor's case", async () => {
    const f = await fixture({ today: true, time: "13:00" });
    expect(await booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.date, time: "14:00", reason: "Synthetic later arrival",
    }, reception)).toMatchObject({ ok: true });
    expect(await db.arriveAppointment(f.appointmentId, { actor: reception.username, actorRole: reception.role })).toBe(true);
    expect(await q("SELECT doctor_id, case_id FROM visits WHERE appointment_id = $1", [f.appointmentId]))
      .toEqual([{ doctor_id: receivingDoctor, case_id: f.caseId }]);
  });

  it("rebooking releases the old appointment for ordinary doctor reassignment", async () => {
    const f = await fixture();
    const replacement = await book(f.patientId, f.nextDate, "11:00", receivingDoctor);
    expect(await step(f.referralId, "schedule", replacement)).toMatchObject({ ok: true });
    expect(await booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.date, time: "12:00", doctorId: otherDoctor,
      reason: "Synthetic old appointment reassignment",
    }, reception)).toMatchObject({ ok: true });
    expect(await q("SELECT referral_id FROM appointments WHERE id = $1", [f.appointmentId])).toEqual([{ referral_id: null }]);
    expect(await db.getReferral(f.referralId)).toMatchObject({ workflowState: "scheduled", appointmentId: replacement });
  });

  it("a valid move preserves no-show, rebooking, completion and acknowledgement", async () => {
    const f = await fixture();
    expect(await booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.date, time: "11:00", reason: "Synthetic time change",
    }, reception)).toMatchObject({ ok: true });
    expect(await db.closeBookedAppointment(f.appointmentId, "no_show", {
      actor: reception.username, actorRole: reception.role,
    })).toBe(true);
    expect(await db.getReferral(f.referralId)).toMatchObject({ workflowState: "accepted", missedAppointment: "no_show" });
    const replacement = await book(f.patientId, f.nextDate, "12:00", receivingDoctor);
    expect(await step(f.referralId, "schedule", replacement)).toMatchObject({ ok: true });
    expect(await step(f.referralId, "complete")).toMatchObject({ ok: true, referral: { workflowState: "completed" } });
    expect(await step(f.referralId, "acknowledge")).toMatchObject({ ok: true, referral: { workflowState: "returned_to_referrer" } });
  });

  describe.each(["link", "move"] as const)("concurrent serialization with %s first", (first) => {
    it.each(["other", "none"] as const)("never persists an internal referral with a %s doctor", async (doctor) => {
      const f = await fixture({ linked: false });
      const doctorId = doctor === "other" ? otherDoctor : null;
      const [linked, moved] = await concurrentLinkAndMove(f, doctorId, first);
      const [persisted] = await q<{ doctor_id: number | null; referral_id: number | null; to_party_id: number | null }>(
        `SELECT a.doctor_id, a.referral_id, r.to_party_id FROM appointments a
         LEFT JOIN patient_referrals r ON r.id = a.referral_id WHERE a.id = $1`, [f.appointmentId],
      );
      expect.soft(persisted.referral_id === null || persisted.doctor_id === persisted.to_party_id,
        "The committed appointment/referral pair must obey the receiving-doctor invariant").toBe(true);
      if (first === "link") {
        expect(linked).toMatchObject({ ok: true });
        expect.soft(moved).toMatchObject({ ok: false, status: 409 });
        expect(persisted).toEqual({ doctor_id: receivingDoctor, referral_id: f.referralId, to_party_id: receivingDoctor });
      } else {
        expect(moved).toMatchObject({ ok: true });
        expect(linked).toEqual({ ok: false, reason: "bad_appointment" });
        expect(persisted).toEqual({ doctor_id: doctorId, referral_id: null, to_party_id: null });
        expect(await db.getReferral(f.referralId)).toMatchObject({ workflowState: "accepted", appointmentId: null });
      }
    });
  });

  it.each(["other", "none"] as const)("sees a newly committed referral after waiting before a %s doctor move", async (doctor) => {
    const f = await fixture({ linked: false });
    await q("UPDATE appointments SET reminder_sent_at = NOW(), patient_confirmed_at = NOW() WHERE id = $1", [f.appointmentId]);
    const before = await snapshot(f);
    const gate = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    let moving: ReturnType<typeof booking.rescheduleAppointment> | undefined;
    let newReferralId: number | undefined;
    await gate.connect();
    try {
      await gate.query("BEGIN");
      const { rows: [backend] } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await gate.query("SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [f.appointmentId]);
      moving = booking.rescheduleAppointment({
        appointmentId: f.appointmentId, date: f.nextDate, time: "11:00",
        doctorId: doctor === "other" ? otherDoctor : null,
        reason: "Synthetic fresh-snapshot reassignment",
      }, reception);
      void moving.catch(() => {});
      await waitForBlockedWriter(backend.pid, "appointments");

      // SQL serialization contract: this synthetic fixture writer creates and
      // links a referral only after the real mover's lock wait is observed.
      // There is no combined create/link application API being simulated here.
      // This prevents a single-statement/CTE implementation from relying on a
      // pre-wait snapshot, even if it avoids flattening NOT EXISTS to an anti join.
      const { rows: [created] } = await gate.query<{ id: number }>(
        `INSERT INTO patient_referrals
           (patient_id, to_name, to_specialty, reason, teeth, urgency, doctor_party_id,
            doctor_name, created_by, kind, to_party_id, workflow_state, case_id,
            blocks_case_id, plan_item_id, return_to_party_id, requested_service_id)
         SELECT patient_id, to_name, to_specialty, reason, teeth, urgency, doctor_party_id,
                doctor_name, created_by, kind, to_party_id, 'scheduled', case_id,
                blocks_case_id, plan_item_id, return_to_party_id, requested_service_id
         FROM patient_referrals WHERE id = $1 RETURNING id`, [f.referralId],
      );
      newReferralId = created.id;
      await gate.query("UPDATE appointments SET referral_id = $2 WHERE id = $1", [f.appointmentId, newReferralId]);
      await gate.query("COMMIT");
    } finally {
      try { await gate.query("ROLLBACK"); }
      finally {
        try { await gate.end(); }
        finally { await Promise.allSettled([moving]); }
      }
    }
    if (!moving || newReferralId === undefined) throw new Error("The concurrent fixture must commit a new referral.");
    expect.soft(await moving).toMatchObject({ ok: false, status: 409 });
    expect(await snapshot(f), "Only the fixture's referral link may change; the refused move must preserve every row").toEqual({
      ...before,
      appointment: { row: { ...before.appointment.row, referral_id: newReferralId } },
    });
    expect(await db.getReferral(newReferralId)).toMatchObject({
      kind: "internal", toPartyId: receivingDoctor, workflowState: "scheduled", appointmentId: f.appointmentId,
    });
  });
});

describe("referral move backward-compatibility controls", () => {
  it.each(["other", "none"] as const)("an external-referral legacy link still permits reassignment to %s", async (doctor) => {
    const f = await fixture({ linked: false });
    const external = await db.createReferral({
      patientId: f.patientId, doctorPartyId: referringDoctor, actor: "synthetic-referrer",
      toName: "Synthetic outside specialist", toSpecialty: "other", reason: "Synthetic external referral",
      teeth: null, urgency: "routine",
    });
    if (!external) throw new Error("Expected synthetic external referral");
    // This is deliberately a legacy-data compatibility fixture. The internal
    // scheduling API does not create external links, but the FK permits them.
    await q("UPDATE appointments SET referral_id = $2 WHERE id = $1", [f.appointmentId, external.id]);
    const doctorId = doctor === "other" ? otherDoctor : null;
    expect(await booking.rescheduleAppointment({
      appointmentId: f.appointmentId, date: f.nextDate, time: "11:00", doctorId,
      reason: "Synthetic legacy external appointment reassignment",
    }, reception)).toMatchObject({ ok: true, appointment: { doctorId } });
    expect(await q("SELECT referral_id FROM appointments WHERE id = $1", [f.appointmentId]))
      .toEqual([{ referral_id: external.id }]);
    expect(await db.getReferral(external.id)).toMatchObject({ kind: "external", workflowState: null });
  });

  it("a same-doctor move waiting behind linking succeeds with context, reminder reset and one audit", async () => {
    const f = await fixture({ linked: false });
    await q("UPDATE appointments SET reminder_sent_at = NOW(), patient_confirmed_at = NOW() WHERE id = $1", [f.appointmentId]);
    const [linked, moved] = await concurrentLinkAndMove(f, receivingDoctor, "link");
    expect(linked).toMatchObject({ ok: true });
    expect(moved).toMatchObject({ ok: true, appointment: { doctorId: receivingDoctor, scheduledDate: f.nextDate } });
    expect(await q("SELECT doctor_id, referral_id, reminder_sent_at, patient_confirmed_at FROM appointments WHERE id = $1", [f.appointmentId]))
      .toEqual([{ doctor_id: receivingDoctor, referral_id: f.referralId, reminder_sent_at: null, patient_confirmed_at: null }]);
    expect(await db.getReferral(f.referralId)).toMatchObject({ workflowState: "scheduled", appointmentId: f.appointmentId, caseId: f.caseId });
    expect(await q("SELECT action FROM audit_log WHERE entity = 'appointment' AND entity_id = $1 AND action = 'appointment.reschedule'", [String(f.appointmentId)]))
      .toEqual([{ action: "appointment.reschedule" }]);
    expect(await q("SELECT id FROM visits WHERE patient_id = $1", [f.patientId])).toEqual([]);
  });

  it("a move waiting behind actual arrival preserves arrived status, referral case and arrival audit", async () => {
    const f = await fixture({ today: true, time: "17:00" });
    const gate = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    let arriving: ReturnType<typeof db.arriveAppointment> | undefined;
    let moving: ReturnType<typeof booking.rescheduleAppointment> | undefined;
    await gate.connect();
    try {
      await gate.query("BEGIN");
      const { rows: [backend] } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await gate.query("SELECT id FROM patient_referrals WHERE id = $1 FOR UPDATE", [f.referralId]);
      arriving = db.arriveAppointment(f.appointmentId, { actor: reception.username, actorRole: reception.role });
      void arriving.catch(() => {});
      const arrivalPid = await waitForBlockedWriter(backend.pid, "FROM patient_referrals");
      moving = booking.rescheduleAppointment({
        appointmentId: f.appointmentId, date: f.nextDate, time: "11:00",
        reason: "Synthetic stale reception move during arrival",
      }, reception);
      void moving.catch(() => {});
      await waitForBlockedWriter(arrivalPid, "appointments");
      expect(await q("SELECT status FROM appointments WHERE id = $1", [f.appointmentId])).toEqual([{ status: "booked" }]);
    } finally {
      try { await gate.query("ROLLBACK"); }
      finally {
        try { await gate.end(); }
        finally { await Promise.allSettled([arriving, moving]); }
      }
    }
    if (!arriving || !moving) throw new Error("Both application writers must have started");
    expect(await arriving).toBe(true);
    expect(await moving).toMatchObject({ ok: false, status: 409 });
    expect(await q("SELECT status, scheduled_date::text, scheduled_time::text, doctor_id, referral_id FROM appointments WHERE id = $1", [f.appointmentId]))
      .toEqual([{ status: "arrived", scheduled_date: f.date, scheduled_time: "17:00:00", doctor_id: receivingDoctor, referral_id: f.referralId }]);
    expect(await db.getReferral(f.referralId)).toMatchObject({ workflowState: "arrived" });
    expect(await q("SELECT doctor_id, case_id FROM visits WHERE appointment_id = $1", [f.appointmentId]))
      .toEqual([{ doctor_id: receivingDoctor, case_id: f.caseId }]);
    expect(await q("SELECT action FROM audit_log WHERE entity = 'appointment' AND entity_id = $1 AND action = 'appointment.reschedule'", [String(f.appointmentId)]))
      .toEqual([]);
    expect(await q("SELECT action FROM audit_log WHERE entity = 'patient' AND entity_id = $1 AND action = 'referral.arrive'", [String(f.patientId)]))
      .toEqual([{ action: "referral.arrive" }]);
  });
});

/**
 * Read-projection contracts reuse this suite's guarded PostgreSQL 18 lifecycle
 * and already patient/referral-linked fixture(). No accounts, permission grants,
 * visits, schema statements, or additional database harness are added here.
 */
describe("referral appointment read projection", () => {
  async function scopeFor(f: Fixture, doctorPartyId: number): Promise<AppointmentReadScope> {
    return {
      kind: "doctor", doctorPartyId,
      ownedPatientIds: await db.doctorOwnedPatientIds(doctorPartyId, [f.patientId]),
    };
  }

  function clinicalFields(referral: Referral) {
    const { appointmentId, appointmentDate, missedAppointment, appointmentVisibility, ...clinical } = referral;
    void appointmentId; void appointmentDate; void missedAppointment; void appointmentVisibility;
    return clinical;
  }

  async function projected(f: Fixture, scope: AppointmentReadScope) {
    const before = await snapshot(f);
    const linkedBefore = await q(
      "SELECT to_jsonb(a) AS row FROM appointments a WHERE referral_id = $1 ORDER BY id", [f.referralId],
    );
    const raw = await db.getReferral(f.referralId);
    expect(raw).not.toBeNull();
    const rows = await db.listPatientReferralsForRead(f.patientId, scope);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(f.referralId);
    expect(clinicalFields(rows[0]), "Reading calendar metadata must preserve every clinical/workflow field")
      .toEqual(clinicalFields(raw!));
    expect(await snapshot(f), "A scoped read cannot change referral, appointment, visit or audit rows").toEqual(before);
    expect(await q("SELECT to_jsonb(a) AS row FROM appointments a WHERE referral_id = $1 ORDER BY id", [f.referralId]))
      .toEqual(linkedBefore);
    return rows[0];
  }

  async function legacyUnassigned(f: Fixture) {
    // Historical nullable-provider state only: keep both existing FK links.
    // This does not assert that today's referral scheduling writer permits it.
    expect(await q(
      `UPDATE appointments SET doctor_id = NULL
        WHERE id = $1 AND patient_id = $2 AND referral_id = $3 RETURNING id`,
      [f.appointmentId, f.patientId, f.referralId],
    )).toEqual([{ id: f.appointmentId }]);
  }

  it("hides a different provider's joined metadata and retains completed clinical content", async () => {
    const f = await fixture();
    expect(await db.transitionInternalReferral({
      id: f.referralId, action: "complete", appointmentId: null,
      note: "Synthetic outcome retained under hidden calendar", procedurePerformed: "Synthetic completed treatment",
      followupRequired: true, mayReturn: false, actor: "synthetic-doctor", actorRole: "doctor",
    })).toMatchObject({ ok: true });
    const scope = await scopeFor(f, otherDoctor);
    expect(scope).toEqual({ kind: "doctor", doctorPartyId: otherDoctor, ownedPatientIds: new Set() });
    expect(await projected(f, scope)).toMatchObject({
      appointmentId: null, appointmentDate: null, missedAppointment: null, appointmentVisibility: "scoped",
      reason: "Synthetic referral treatment", outcomeNote: "Synthetic outcome retained under hidden calendar",
      procedurePerformed: "Synthetic completed treatment", workflowState: "completed", status: "completed",
      followupRequired: true, mayReturn: false, caseId: f.caseId,
    });
  });

  it("keeps the own-provider branch even when ownership evidence is unavailable", async () => {
    const f = await fixture();
    // The existing canonical resolver produces this scope when its ownership
    // lookup fails. Supplying it tests that branch without creating any grant.
    const scope: AppointmentReadScope = { kind: "doctor", doctorPartyId: receivingDoctor, ownedPatientIds: new Set() };
    expect(await projected(f, scope)).toMatchObject({
      appointmentId: f.appointmentId, appointmentDate: `${f.date} ${f.time}`, appointmentVisibility: "scoped",
    });
  });

  it("keeps the canonical unassigned branch for a doctor who does not own the patient", async () => {
    const f = await fixture();
    await legacyUnassigned(f);
    const scope = await scopeFor(f, otherDoctor);
    expect(scope).toEqual({ kind: "doctor", doctorPartyId: otherDoctor, ownedPatientIds: new Set() });
    expect(await projected(f, scope)).toMatchObject({
      appointmentId: f.appointmentId, appointmentDate: `${f.date} ${f.time}`, appointmentVisibility: "scoped",
    });
  });

  it("keeps another provider's appointment for a canonically owned patient and for full readers", async () => {
    const f = await fixture();
    const owned = await scopeFor(f, referringDoctor);
    expect(owned).toEqual({ kind: "doctor", doctorPartyId: referringDoctor, ownedPatientIds: new Set([f.patientId]) });
    for (const scope of [owned, { kind: "all" } as const]) {
      expect(await projected(f, scope)).toMatchObject({
        appointmentId: f.appointmentId, appointmentDate: `${f.date} ${f.time}`, appointmentVisibility: "all",
      });
    }
  });

  it.each(["assigned", "unassigned"] as const)("hides all joined metadata with no calendar scope, including %s rows", async (provider) => {
    const f = await fixture();
    if (provider === "unassigned") await legacyUnassigned(f);
    expect(await projected(f, { kind: "none" })).toMatchObject({
      appointmentId: null, appointmentDate: null, missedAppointment: null, appointmentVisibility: "hidden",
      workflowState: "scheduled", status: "sent", reason: "Synthetic referral treatment",
    });
  });

  it.each(["current", "last"] as const)("scopes the %s readable appointment independently of the other joined row", async (readable) => {
    const f = await fixture();
    if (readable === "current") await legacyUnassigned(f);
    // A bounded historical two-link fixture exercises the two different lateral
    // selections. Both appointments reference this already-created patient and
    // referral at insertion; no appointment/visit identity is left unlinked.
    const [latest] = await q<{ id: number }>(
      `INSERT INTO appointments (patient_id, referral_id, scheduled_date, scheduled_time, doctor_id)
       SELECT patient_id, referral_id, $4::date, '11:00', $5
         FROM appointments WHERE id = $1 AND patient_id = $2 AND referral_id = $3
       RETURNING id`,
      [f.appointmentId, f.patientId, f.referralId, f.nextDate, readable === "last" ? null : receivingDoctor],
    );
    expect(latest?.id).toBeGreaterThan(f.appointmentId);
    // Retain a completed historical appointment as the non-cancelled current
    // metadata row. A second booked link would correctly suppress unscheduling.
    expect(await q(
      `UPDATE appointments SET status = 'done'
        WHERE id = $1 AND patient_id = $2 AND referral_id = $3 RETURNING id`,
      [f.appointmentId, f.patientId, f.referralId],
    )).toEqual([{ id: f.appointmentId }]);
    expect(await db.closeBookedAppointment(latest.id, "no_show", {
      actor: reception.username, actorRole: reception.role,
    })).toBe(true);
    expect(await db.getReferral(f.referralId)).toMatchObject({
      appointmentId: f.appointmentId, missedAppointment: "no_show", workflowState: "accepted",
    });
    const scope = await scopeFor(f, otherDoctor);
    expect(scope).toEqual({ kind: "doctor", doctorPartyId: otherDoctor, ownedPatientIds: new Set() });
    expect(await projected(f, scope)).toMatchObject({
      appointmentId: readable === "current" ? f.appointmentId : null,
      appointmentDate: readable === "current" ? `${f.date} ${f.time}` : null,
      missedAppointment: readable === "last" ? "no_show" : null,
      appointmentVisibility: "scoped", workflowState: "accepted", status: "sent",
    });
  });

  it("keeps deleted-appointment audit fallback only for existing full-patient calendar scope", async () => {
    const f = await fixture();
    expect(await db.deleteAppointment(f.appointmentId, {
      actor: reception.username, actorRole: reception.role, reason: "Synthetic duplicate booking",
    })).toMatchObject({ ok: true });
    expect(await q("SELECT id FROM appointments WHERE referral_id = $1", [f.referralId])).toEqual([]);
    expect(await q(
      `SELECT details->>'الإحالة' AS referral_id FROM audit_log
        WHERE entity = 'patient' AND entity_id = $1 AND action = 'referral.unschedule'`, [String(f.patientId)],
    )).toEqual([{ referral_id: String(f.referralId) }]);
    expect(await db.getReferral(f.referralId)).toMatchObject({
      appointmentId: null, appointmentDate: null, missedAppointment: "cancelled", workflowState: "accepted",
    });
    expect(await projected(f, await scopeFor(f, otherDoctor))).toMatchObject({
      appointmentId: null, appointmentDate: null, missedAppointment: null, appointmentVisibility: "scoped",
    });
    expect(await projected(f, { kind: "none" })).toMatchObject({
      appointmentId: null, appointmentDate: null, missedAppointment: null, appointmentVisibility: "hidden",
    });
    for (const scope of [await scopeFor(f, referringDoctor), { kind: "all" } as const]) {
      expect(await projected(f, scope)).toMatchObject({
        appointmentId: null, appointmentDate: null, missedAppointment: "cancelled", appointmentVisibility: "all",
      });
    }
  });
});
