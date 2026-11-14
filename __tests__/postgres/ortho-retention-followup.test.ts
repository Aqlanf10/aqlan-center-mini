import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { GET } from "../../app/api/ortho/followups/route";
import type { FollowupRow } from "../../lib/ortho-followup";
import { PHASE_ORDER, type OrthoPhase } from "../../lib/ortho";
import type { Role } from "../../lib/roles";
import { openPeriodontalFixture } from "./_periodontal-fixture";

// Actual signed-cookie route, real PostgreSQL18 reads, entirely owned synthetic
// data. This verifies read projections, not retention treatment or scheduling.
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let doctor: number;
let admitted: SessionPayload;
const TODAY = "2026-11-05";
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-retention-followup-only-20261105");
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema();
  doctor = (await fixture.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic retention doctor') RETURNING id")).rows[0].id;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
});
afterAll(async () => { try { await fixture?.close(); } finally { vi.useRealTimers(); vi.unstubAllEnvs(); } });

async function actor(role: Role = "admin", partyId: number | null = null) {
  const username = `synthetic-retention-${randomUUID()}`;
  const password = "synthetic-only-password-hash";
  const id = (await fixture.pool.query(
    "INSERT INTO users(username,display_name,password_hash,role,party_id,permissions) VALUES($1,'Synthetic retention account',$2,$3,$4,'{}') RETURNING id",
    [username, password, role, partyId],
  )).rows[0].id;
  admitted = { userId: id, username, role, partyId,
    expiresAt: Date.now() + 3_600_000, credentialVersion: sessionCredentialVersion(password) };
  request.token = createSessionToken(admitted);
}

async function caseRow(options: {
  status?: "active" | "retention" | "completed";
  phase?: "aligning" | "finishing" | "retention";
  lastAdjustment?: string | null;
  owner?: number;
} = {}) {
  const patientId = (await fixture.pool.query(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id",
    [randomUUID(), `Synthetic retention patient ${randomUUID()}`, options.owner ?? doctor],
  )).rows[0].id;
  const id = (await fixture.pool.query(
    `INSERT INTO ortho_cases(patient_id,status,phase,start_date,retainer,retainer_on,created_by)
     VALUES($1,$2,$3,'2020-01-01','essix','2026-01-02','synthetic-retention') RETURNING id`,
    [patientId, options.status ?? "retention", options.phase ?? "retention"],
  )).rows[0].id;
  if (options.lastAdjustment !== null) await fixture.pool.query(
    `INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,upper_wire,recorded_by)
     VALUES($1,$2,4,'Synthetic historical wire','synthetic-retention')`,
    [id, options.lastAdjustment ?? "2026-07-01"],
  );
  return { id, patientId };
}

async function appointment(patientId: number, date: string, status: string, type = "follow_up") {
  return (await fixture.pool.query(
    `INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,appointment_type)
     VALUES($1,$2,'10:30',$3,$4) RETURNING id`, [patientId, date, status, type],
  )).rows[0].id as number;
}

async function footprint() {
  // Compare all owned fixture table rows as driver-decoded JSON strings. This
  // is not physical storage-byte equality or a production database inspection.
  const tables = (await fixture.pool.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  )).rows;
  const state: Record<string, unknown> = {};
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    state[name] = (await fixture.pool.query(`SELECT to_jsonb(t)::text AS value FROM ${quoted} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return state;
}

async function read(status = 200) {
  const before = await footprint();
  const response = await GET(new Request("http://localhost/api/ortho/followups"));
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
function unknownRetention(row: FollowupRow) {
  expect(row).toMatchObject({ dueDate: null, daysSinceLast: null, dueBasis: "retention_schedule_unavailable" });
  expect(row.buckets).toContain("retention");
  expect(row.buckets).not.toEqual(expect.arrayContaining(["lapsed_4"]));
  expect(row.buckets).not.toEqual(expect.arrayContaining(["lapsed_6"]));
  expect(row.buckets).not.toEqual(expect.arrayContaining(["lapsed_8"]));
}

it.each([
  { status: "retention", phase: "retention", lastAdjustment: "2026-07-01" },
  { status: "retention", phase: "finishing", lastAdjustment: "2026-07-01" },
  { status: "active", phase: "retention", lastAdjustment: "2026-07-01" },
  { status: "retention", phase: "retention", lastAdjustment: null },
] as const)("withholds adjustment-derived retention timing for %j without changing any stored row", async options => {
  await actor(); const target = await caseRow(options);
  const row = projected(await read(), target.id);
  unknownRetention(row);
  expect(row.lastAdjustmentDate).toBe(options.lastAdjustment);
  expect(row.startDate).toBe("2020-01-01");
  expect(row.status).toBe(options.status); expect(row.phase).toBe(options.phase);
  expect(row.buckets).toContain("no_appointment");
});

it.each(["booked", "arrived"])("retains actual future %s booking without promoting it to clinical retention due", async status => {
  await actor(); const target = await caseRow();
  const id = await appointment(target.patientId, "2026-11-06", status);
  const row = projected(await read(), target.id);
  unknownRetention(row); expect(row.buckets).toContain("tomorrow");
  expect(row.nextAppointment).toMatchObject({ id, date: "2026-11-06", time: "10:30", status });
});

it("preserves a past unresolved booking as booking-overdue, not retention clinical lapse", async () => {
  await actor(); const target = await caseRow();
  const id = await appointment(target.patientId, "2026-11-03", "booked");
  const row = projected(await read(), target.id);
  unknownRetention(row); expect(row.buckets).toContain("overdue"); expect(row.nextAppointment).toBeNull();
  expect(row.bookingContext?.pastUnresolvedAppointment).toMatchObject({ id, date: "2026-11-03" });
});

it("keeps unknown/unrelated bookings and legacy no-show evidence separate from retention timing", async () => {
  await actor(); const target = await caseRow();
  await appointment(target.patientId, "2026-10-01", "no_show");
  const unrelated = await appointment(target.patientId, "2026-11-06", "booked", "endo");
  const row = projected(await read(), target.id);
  unknownRetention(row); expect(row.nextAppointment).toBeNull();
  expect(row.buckets).toEqual(expect.arrayContaining(["no_show", "no_appointment"]));
  expect(row.bookingContext?.otherAppointments).toEqual(expect.arrayContaining([expect.objectContaining({ id: unrelated })]));
});

it.each([
  ["2026-10-08", "lapsed_4", "2026-11-05", 28],
  ["2026-09-24", "lapsed_6", "2026-10-22", 42],
  ["2026-09-10", "lapsed_8", "2026-10-08", 56],
] as const)("preserves active-care arithmetic and bucket for %s", async (date, bucket, due, days) => {
  await actor(); const target = await caseRow({ status: "active", phase: "finishing", lastAdjustment: date });
  const row = projected(await read(), target.id);
  expect(row).toMatchObject({ dueDate: due, daysSinceLast: days, dueBasis: "adjustment_interval" });
  expect(row.buckets).toContain(bucket); expect(row.buckets).not.toContain("retention");
});

it("preserves current doctor ownership filtering and excludes closed cases", async () => {
  const other = (await fixture.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic foreign retention doctor') RETURNING id")).rows[0].id;
  const owned = await caseRow(); const foreign = await caseRow({ owner: other }); const closed = await caseRow({ status: "completed" });
  await actor("doctor", doctor); const payload = await read();
  unknownRetention(projected(payload, owned.id));
  const ids = payload.buckets.flatMap(bucket => bucket.rows.map(row => row.caseId));
  expect(ids).not.toContain(foreign.id); expect(ids).not.toContain(closed.id);
});

it("does not expose board data to a doctor without a current party link", async () => {
  await actor("doctor"); const payload = await read(403);
  expect(payload).not.toHaveProperty("buckets");
});

it.each(["phase", "retainer"] as const)("projects the %s writer without inferring a lifecycle transition", async kind => {
  await actor(); const target = await caseRow({ status: "active", phase: "finishing" });
  // Exercise the existing writers only as synthetic setup. The following GET
  // must not synchronize either field or manufacture retention review history.
  if (kind === "phase") {
    expect(await fixture.db.setOrthoPhase(target.id, "retention", { patientId: target.patientId, session: admitted })).toBe(true);
  } else {
    expect(await fixture.db.setRetainer({ id: target.id, retainer: "essix", deliveredOn: "2026-11-01" }, { patientId: target.patientId, session: admitted })).toBe(true);
  }
  const row = projected(await read(), target.id);
  if (kind === "phase") {
    unknownRetention(row);
    expect(row).toMatchObject({ status: "active", phase: "retention" });
  } else {
    expect(row).toMatchObject({ status: "active", phase: "finishing", dueBasis: "adjustment_interval" });
    expect(row.buckets).not.toContain("retention");
  }
});

// Direct-writer boundaries must not depend on TypeScript or route admission.
it.each(["assessment", "invented", "", "constructor", null, 17])("rejects invalid direct phase %j without changing any fixture row", async phase => {
  await actor(); const target = await caseRow({ status: "active", phase: "finishing" });
  const before = await footprint();
  expect(await fixture.db.setOrthoPhase(target.id, phase as OrthoPhase, { patientId: target.patientId, session: admitted })).toBe(false);
  expect(await footprint()).toEqual(before);
});
it.each(["active", "retention"] as const)("preserves supported phase-only writes and legacy metadata in %s cases", async status => {
  await actor(); const target = await caseRow({ status, phase: "finishing" });
  const before = await footprint();
  for (const phase of PHASE_ORDER) {
    expect(await fixture.db.setOrthoPhase(target.id, phase, { patientId: target.patientId, session: admitted })).toBe(true);
    const [{ value }] = (await fixture.pool.query("SELECT to_jsonb(c) value FROM ortho_cases c WHERE id=$1", [target.id])).rows;
    expect(value).toMatchObject({ status, phase, retainer: "essix", retainer_on: "2026-01-02" });
  }
  // Restore the original phase; only the five explicit phase audit rows may differ.
  expect(await fixture.db.setOrthoPhase(target.id, "finishing", { patientId: target.patientId, session: admitted })).toBe(true);
  const after = await footprint();
  expect((after.audit_log as unknown[]).length).toBe((before.audit_log as unknown[]).length + 5);
  const audits = (await fixture.pool.query("SELECT action,entity,entity_id,actor FROM audit_log WHERE action='ortho.phase' AND entity_id=$1 ORDER BY id", [String(target.id)])).rows;
  expect(audits).toHaveLength(5);
  expect(audits.every(a => a.action === "ortho.phase" && a.entity === "ortho_cases" && a.actor === admitted.username)).toBe(true);
  expect({ ...after, audit_log: before.audit_log }).toEqual(before);
});
it("keeps closed cases and nonexistent IDs outside the phase writer", async () => {
  await actor(); const target = await caseRow({ status: "completed", phase: "retention" });
  const before = await footprint();
  expect(await fixture.db.setOrthoPhase(target.id, "working", { patientId: target.patientId, session: admitted })).toBe(false);
  expect(await fixture.db.setOrthoPhase(2147483647, "retention", { patientId: target.patientId, session: admitted })).toBe(false);
  expect(await footprint()).toEqual(before);
});
