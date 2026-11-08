import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion } from "../../lib/auth";
import { GET } from "../../app/api/ortho/followups/route";
import type { FollowupRow } from "../../lib/ortho-followup";
import { openPeriodontalFixture } from "./_periodontal-fixture";

// Real PG18 and actual signed-cookie route, using owned synthetic rows only.
// Appointment-slot outcomes are not proof of performed orthodontic treatment.
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let doctor: number;
const AS_OF = "2026-11-05T09:00:00.000Z"; // 12:00 in the clinic's Asia/Aden zone.
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-followup-attendance-only-20261105");
  vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema();
  doctor = (await fixture.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic attendance doctor') RETURNING id")).rows[0].id;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterAll(async () => { try { await fixture?.close(); } finally { vi.useRealTimers(); vi.unstubAllEnvs(); } });

async function actor(options: { instant?: string; doctor?: boolean; partyId?: number | null } = {}) {
  vi.setSystemTime(new Date(options.instant ?? AS_OF));
  const username = `synthetic-attendance-${randomUUID()}`;
  const password = "synthetic-only-password-hash";
  const role = options.doctor ? "doctor" : "admin";
  const partyId = options.doctor ? (options.partyId === undefined ? doctor : options.partyId) : null;
  const id = (await fixture.pool.query(
    "INSERT INTO users(username,display_name,password_hash,role,party_id,permissions) VALUES($1,'Synthetic attendance account',$2,$3,$4,'{}') RETURNING id",
    [username, password, role, partyId],
  )).rows[0].id;
  request.token = createSessionToken({ userId: id, username, role, partyId,
    expiresAt: Date.now() + 3_600_000, credentialVersion: sessionCredentialVersion(password) });
}

async function caseRow(options: { retention?: boolean; closed?: boolean; owner?: number } = {}) {
  const patientId = (await fixture.pool.query(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id",
    [randomUUID(), `Synthetic attendance patient ${randomUUID()}`, options.owner ?? doctor],
  )).rows[0].id;
  const id = (await fixture.pool.query(
    `INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by)
     VALUES($1,$2,$3,'2026-01-01','synthetic-attendance') RETURNING id`,
    [patientId, options.closed ? "completed" : options.retention ? "retention" : "active", options.retention ? "retention" : "aligning"],
  )).rows[0].id;
  await fixture.pool.query(
    "INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by) VALUES($1,'2026-07-01',4,'synthetic-attendance')", [id],
  );
  return { id, patientId };
}

async function appointment(patientId: number, date: string, time: string, status: string, options: { type?: string; endedAt?: string } = {}) {
  return (await fixture.pool.query(
    `INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,appointment_type,ended_at)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [patientId, date, time, status, options.type ?? "follow_up", options.endedAt ?? null],
  )).rows[0].id as number;
}

async function footprint() {
  const tables = (await fixture.pool.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  )).rows;
  const tableRows: Record<string, unknown> = {};
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    tableRows[name] = (await fixture.pool.query(`SELECT to_jsonb(t)::text AS value FROM ${quoted} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  const sequences = (await fixture.pool.query(
    "SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
  )).rows;
  return { tableRows, sequences };
}

async function read(status = 200) {
  const before = await footprint();
  const response = await GET();
  const payload = await response.json();
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await footprint()).toEqual(before);
  return payload as { today: string; buckets: { bucket: string; rows: FollowupRow[] }[] };
}

function projected(payload: Awaited<ReturnType<typeof read>>, id: number) {
  const copies = payload.buckets.flatMap(bucket => bucket.rows).filter(row => row.caseId === id);
  expect(copies.length).toBeGreaterThan(0);
  for (const row of copies) expect(row).toEqual(copies[0]);
  return copies[0];
}

function missed(row: FollowupRow, expected: boolean) {
  expect(row.lastWasNoShow).toBe(expected);
  expect(row.buckets.includes("no_show")).toBe(expected);
}

it.each(["arrived", "done"])("a strictly later recorded %s slot supersedes an old miss without proving orthodontic care", async status => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-10-01", "10:00", "no_show");
  await appointment(target.patientId, "2026-11-04", "10:00", status, { type: "endo" });
  const row = projected(await read(), target.id);
  missed(row, false);
  expect(row).toMatchObject({ attendanceContext: { basis: "current_status_scheduled_slot", outcome: "attendance",
    latestScheduledLocal: "2026-11-04T10:00:00.000000", cutoff: { kind: "explicit_instant", instant: AS_OF, timeZone: "Asia/Aden" } } });
  expect(row.buckets).toEqual(expect.arrayContaining(["lapsed_8", "no_appointment"]));
  expect(row.lastAdjustmentDate).toBe("2026-07-01");
});

it.each(["arrived", "done"])("a later missed slot remains unresolved after older %s", async status => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-10-01", "10:00", status);
  await appointment(target.patientId, "2026-11-04", "10:00", "no_show");
  missed(projected(await read(), target.id), true);
});

it.each(["booked", "cancelled"])("a later %s slot never establishes attendance or clears a miss", async status => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-10-01", "10:00", "no_show");
  await appointment(target.patientId, "2026-11-04", "10:00", status);
  await appointment(target.patientId, "2026-11-06", "10:00", status);
  missed(projected(await read(), target.id), true);
});

it.each(["arrived", "done"])("future dated or same-day later %s outcomes cannot clear a miss", async status => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-11-04", "10:00", "no_show");
  await appointment(target.patientId, "2026-11-05", "13:00", status);
  await appointment(target.patientId, "2026-11-06", "10:00", status);
  missed(projected(await read(), target.id), true);
});

it.each([["2026-11-06", "10:00"], ["2026-11-05", "13:00"], ["2026-11-05", "12:00:00.000001"]])(
  "future no-show slot %s %s does not create a current absence flag", async (date, time) => {
    await actor(); const target = await caseRow();
    await appointment(target.patientId, date, time, "no_show");
    const row = projected(await read(), target.id);
    missed(row, false);
    expect(row).toMatchObject({ attendanceContext: { outcome: "none", latestScheduledLocal: null } });
  },
);

it.each([false, true])("same-day slot time, not insertion order, resolves attendance (reverse=%s)", async reverse => {
  await actor(); const target = await caseRow();
  const outcomes = [{ time: "10:00", status: "no_show" }, { time: "11:00", status: "done" }];
  for (const outcome of reverse ? outcomes.reverse() : outcomes) await appointment(target.patientId, "2026-11-05", outcome.time, outcome.status);
  missed(projected(await read(), target.id), false);
});

it("preserves full PostgreSQL TIME precision when a later eligible outcome is in the same second", async () => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-11-05", "11:00:00.000002", "done");
  await appointment(target.patientId, "2026-11-05", "11:00:00.000001", "no_show");
  missed(projected(await read(), target.id), false);
});

it.each([false, true])("same-slot conflicting outcomes conservatively retain the miss without an ID tie-break (reverse=%s)", async reverse => {
  await actor(); const target = await caseRow();
  for (const status of reverse ? ["done", "no_show"] : ["no_show", "done"]) await appointment(target.patientId, "2026-11-05", "11:00", status);
  const row = projected(await read(), target.id);
  missed(row, true);
  expect(row).toMatchObject({ attendanceContext: { outcome: "conflict", latestScheduledLocal: "2026-11-05T11:00:00.000000" } });
});

it("a backfilled older miss cannot outrank a later slot by ID or mutation time", async () => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-11-04", "10:00", "done", { endedAt: "2026-11-04T08:00:00Z" });
  await appointment(target.patientId, "2026-10-01", "10:00", "no_show", { endedAt: AS_OF });
  missed(projected(await read(), target.id), false);
});

it("late reconciliation of an older completed slot cannot clear a newer scheduled miss", async () => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-11-04", "10:00", "no_show");
  await appointment(target.patientId, "2026-10-01", "10:00", "done", { endedAt: AS_OF });
  missed(projected(await read(), target.id), true);
});

it("clearing a retention no-show does not manufacture a retention recall or adjustment", async () => {
  await actor(); const target = await caseRow({ retention: true });
  await appointment(target.patientId, "2026-10-01", "10:00", "no_show");
  await appointment(target.patientId, "2026-11-04", "10:00", "done");
  const row = projected(await read(), target.id);
  missed(row, false);
  expect(row).toMatchObject({ dueDate: null, daysSinceLast: null, dueBasis: "retention_schedule_unavailable", lastAdjustmentDate: "2026-07-01" });
  expect(row.buckets).toEqual(expect.arrayContaining(["retention", "no_appointment"]));
  expect(row.buckets.some(bucket => bucket.startsWith("lapsed_"))).toBe(false);
});

it("captures clinic midnight once and includes an outcome exactly at that instant", async () => {
  await actor({ instant: "2026-11-04T21:00:00.000Z" }); const target = await caseRow();
  await appointment(target.patientId, "2026-11-04", "23:59:59.999999", "no_show");
  await appointment(target.patientId, "2026-11-05", "00:00", "done");
  const payload = await read();
  expect(payload.today).toBe("2026-11-05");
  missed(projected(payload, target.id), false);
});

it("retains a miss exactly at the cutoff and treats 24:00 as the next midnight", async () => {
  await actor({ instant: "2026-11-04T21:00:00.000Z" }); const target = await caseRow();
  await appointment(target.patientId, "2026-11-04", "24:00", "no_show");
  await appointment(target.patientId, "2026-11-05", "00:00", "done");
  const row = projected(await read(), target.id);
  missed(row, true);
  expect(row).toMatchObject({ attendanceContext: { outcome: "conflict", latestScheduledLocal: "2026-11-05T00:00:00.000000" } });
});

it("does not count 24:00 while the clinic is still on the preceding day", async () => {
  await actor({ instant: "2026-11-04T20:59:59.999Z" }); const target = await caseRow();
  await appointment(target.patientId, "2026-11-04", "24:00", "no_show");
  missed(projected(await read(), target.id), false);
});

it("preserves current doctor scope, closed-case exclusion and patient-separated outcome selection", async () => {
  await actor({ doctor: true });
  const other = (await fixture.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic foreign attendance doctor') RETURNING id")).rows[0].id;
  const own = await caseRow(); const foreign = await caseRow({ owner: other }); const closed = await caseRow({ closed: true });
  await appointment(own.patientId, "2026-10-01", "10:00", "no_show");
  await appointment(foreign.patientId, "2026-11-04", "10:00", "done");
  const payload = await read();
  missed(projected(payload, own.id), true);
  const ids = payload.buckets.flatMap(bucket => bucket.rows.map(row => row.caseId));
  expect(ids).not.toContain(foreign.id); expect(ids).not.toContain(closed.id);
});

it("does not expose attendance or board rows to an unlinked doctor", async () => {
  await actor({ doctor: true, partyId: null });
  expect(await read(403)).not.toHaveProperty("buckets");
});

it("keeps the exact inclusive millisecond cutoff distinct from a later PostgreSQL microsecond", async () => {
  await actor({ instant: "2026-11-05T09:00:00.123Z" });
  const at = await caseRow(); const after = await caseRow();
  await appointment(at.patientId, "2026-11-05", "12:00:00.123000", "no_show");
  await appointment(after.patientId, "2026-11-05", "12:00:00.123001", "no_show");
  const payload = await read();
  missed(projected(payload, at.id), true); missed(projected(payload, after.id), false);
});

async function directRead(today: string, asOf?: Date) {
  const before = await footprint();
  try { return await fixture.db.orthoFollowupBoard(today, asOf); }
  finally { expect(await footprint()).toEqual(before); }
}

it("preserves the current-day one-argument caller with one captured clinic instant", async () => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-11-05", "13:00", "no_show");
  const row = (await directRead("2026-11-05")).find(item => item.caseId === target.id);
  expect(row).toMatchObject({ lastWasNoShow: false, attendanceContext: { outcome: "none", cutoff: {
    kind: "captured_now", instant: AS_OF, localDateTime: "2026-11-05T12:00:00.000000", timeZone: "Asia/Aden",
  } } });
});

it("labels historical date-only reads as strictly before that clinic day, without borrowing today's time", async () => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-11-03", "23:59:59.999999", "no_show");
  await appointment(target.patientId, "2026-11-04", "00:00", "done");
  await appointment(target.patientId, "2026-11-04", "13:00", "done");
  const row = (await directRead("2026-11-04")).find(item => item.caseId === target.id);
  expect(row).toMatchObject({ lastWasNoShow: true, attendanceContext: {
    outcome: "no_show", latestScheduledLocal: "2026-11-03T23:59:59.999999", cutoff: {
      kind: "date_only_before_midnight", instant: null, localDateTime: "2026-11-04T00:00:00.000000", timeZone: "Asia/Aden",
    },
  } });
});

it("excludes previous-day 24:00 as well as same-day 00:00 from the date-only boundary", async () => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-11-03", "24:00", "no_show");
  await appointment(target.patientId, "2026-11-04", "00:00", "no_show");
  const row = (await directRead("2026-11-04")).find(item => item.caseId === target.id);
  expect(row).toMatchObject({ lastWasNoShow: false, attendanceContext: {
    outcome: "none", latestScheduledLocal: null, cutoff: { kind: "date_only_before_midnight" },
  } });
});

it.each([
  ["2026-11-04", "2026-11-05T09:00:00.000Z"],
  ["2026-11-05", "invalid"],
  ["2026-02-30", "2026-11-05T09:00:00.000Z"],
] as const)("rejects inconsistent or invalid explicit cutoff %s / %s without changing rows", async (today, instant) => {
  await actor();
  await expect(directRead(today, new Date(instant))).rejects.toThrow();
});

it("returns current recorded statuses rather than pretending the cutoff reconstructs historical knowledge", async () => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-10-01", "10:00", "no_show");
  const later = await appointment(target.patientId, "2026-11-04", "10:00", "done");
  missed(projected(await read(), target.id), false);
  // Synthetic setup simulates a late status correction; each GET remains read-only.
  await fixture.pool.query("UPDATE appointments SET status='no_show',ended_at=$2 WHERE id=$1", [later, AS_OF]);
  const row = projected(await read(), target.id);
  missed(row, true);
  expect(row).toMatchObject({ attendanceContext: { basis: "current_status_scheduled_slot", outcome: "no_show" } });
});
