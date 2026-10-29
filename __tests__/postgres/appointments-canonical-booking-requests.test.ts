/** M2 slice 21: canonical online booking requests (GET /api/booking-requests, PATCH
 * /api/booking-requests/[id]) on real PostgreSQL, synthetic data only. The queue needs
 * appointments.create and the whole appointment scope; confirmation runs the same
 * capacity-engine door on the admitted transaction (a new patient also needs
 * patients.create) with every audit row atomic; rejection is appointments.cancel. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-booking-requests-2026");
const db = await import("../../lib/db");
const requests = await import("../../lib/canonical-booking-requests");
const door = await import("../../lib/booking-request-confirm");

const DATE = "2027-06-08";
const DESK = { "appointments.create": true, "appointments.cancel": true, "patients.create": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-BR-OWNER", role: "admin" },
  desk: { username: "SYN-BR-DESK", role: "reception", appointmentScope: "all", grants: DESK },
  noPatients: { username: "SYN-BR-NOPATIENTS", role: "admin", appointmentScope: "all", grants: { "appointments.create": true } },
  overrider: { username: "SYN-BR-OVERRIDE", role: "reception", appointmentScope: "all", grants: { ...DESK, "appointments.override-capacity": true } },
  rejecter: { username: "SYN-BR-REJECT", role: "reception", appointmentScope: "all", grants: { "appointments.cancel": true } },
  doctor: { username: "SYN-BR-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", grants: DESK },
  revoked: { username: "SYN-BR-REVOKED", role: "reception", appointmentScope: "all", grants: DESK },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let counter = 0;

const request = async (phone?: string) => {
  counter += 1;
  return (await fx.pool.query<{ id: number }>("INSERT INTO booking_requests(full_name, phone, reason, preferred_period) VALUES($1,$2,'Synthetic reason','morning') RETURNING id",
    [`SYN Requester ${counter}`, phone ?? `05000003${String(counter).padStart(2, "0")}`])).rows[0].id;
};
const confirm = async (k: Key, id: number, body: Record<string, unknown>) =>
  requests.commandCanonicalBookingRequestConfirm(await fx.session(k), id, ({ client, actor, audit, allowNewPatient }) =>
    door.confirmBookingRequestThroughEngine(id, { action: "confirm", ...body }, actor, { client, audit, allowNewPatient }));
const status = async (id: number) => (await fx.pool.query<{ status: string; appointment_id: number | null }>("SELECT status, appointment_id FROM booking_requests WHERE id=$1", [id])).rows[0];
const audits = async (action: string) => (await fx.pool.query<{ actor: string; entity_id: string }>("SELECT actor, entity_id FROM audit_log WHERE action=$1 ORDER BY id", [action])).rows;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  for (const [key, value] of [["clinic.chairs", "1"], ["clinic.day_start", "08:00"], ["clinic.day_end", "20:00"]]) {
    await fx.pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
  }
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("the queue", () => {
  it("lists new requests oldest first for appointments.create with the whole scope only", async () => {
    const first = await request();
    const listed = await requests.readCanonicalBookingRequests(await fx.session("desk"), "new");
    expect(listed.map(row => row.id)).toContain(first);
    await expect(requests.readCanonicalBookingRequests(await fx.session("doctor"), "new")).rejects.toThrow(/SCOPE/);
    await expect(requests.readCanonicalBookingRequests(await fx.session("rejecter"), "new")).rejects.toThrow(/CAPABILITY_DENIED/);
    expect(() => requests.parseBookingRequestStatus("archived")).toThrow(expect.objectContaining({ code: "invalid_booking_request" }));
  });
});

describe("confirmation through the capacity engine", () => {
  it("confirms a new person: patient, appointment and request closed together, every audit row atomic", async () => {
    const id = await request();
    const result = await confirm("desk", id, { date: DATE, time: "09:00", durationMinutes: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await status(id)).toEqual({ status: "confirmed", appointment_id: result.confirmed.appointmentId });
    expect((await audits("booking_request.confirm")).filter(row => row.entity_id === String(id)).map(row => row.actor)).toEqual(["SYN-BR-DESK"]);
    expect((await audits("appointment.create")).filter(row => row.entity_id === String(result.confirmed.appointmentId)).map(row => row.actor)).toEqual(["SYN-BR-DESK"]);
    // A second press never books twice (the engine may already refuse it as the same
    // person's nearby appointment, as on the legacy route; either way nothing is written).
    expect((await confirm("desk", id, { date: DATE, time: "10:00" })).ok).toBe(false);
    expect(await status(id)).toEqual({ status: "confirmed", appointment_id: result.confirmed.appointmentId });
  });
  it("a new person needs patients.create; an existing patient's request does not", async () => {
    const stranger = await request();
    expect(await confirm("noPatients", stranger, { date: DATE, time: "11:00" })).toEqual({ ok: false, kind: "patient_create_required" });
    expect(await status(stranger)).toEqual({ status: "new", appointment_id: null });
    await fx.pool.query("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-BR-P1','SYN Known Requester','0599999901')");
    const known = await request("0599999901");
    expect((await confirm("noPatients", known, { date: DATE, time: "11:00" })).ok).toBe(true);
  });
  it("a full chair is a conflict that leaves the request new; a role label never overrides; the grant does, audited", async () => {
    // A known patient's request, so the admin-labelled account without the override
    // grant reaches the capacity judgement.
    await fx.pool.query("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-BR-P2','SYN Known Requester 2','0599999902')");
    const id = await request("0599999902");
    const full = await confirm("noPatients", id, { date: DATE, time: "09:00", overrideReason: "Synthetic: try" });
    expect(full).toMatchObject({ ok: false, kind: "conflict" });
    expect(await status(id)).toEqual({ status: "new", appointment_id: null });
    const overridden = await confirm("overrider", id, { date: DATE, time: "09:00", overrideReason: "Synthetic: urgent" });
    expect(overridden.ok).toBe(true);
    if (overridden.ok) expect((await audits("appointment.capacity_override")).filter(row => row.entity_id === String(overridden.confirmed.appointmentId)).map(row => row.actor)).toEqual(["SYN-BR-OVERRIDE"]);
  });
  it("two concurrent confirmations of one request: one appointment", async () => {
    const id = await request();
    const results = await Promise.all([confirm("desk", id, { date: DATE, time: "14:00" }), confirm("desk", id, { date: DATE, time: "15:00" })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(Number((await fx.pool.query("SELECT count(*) FROM appointments a JOIN booking_requests r ON r.appointment_id = a.id WHERE r.id=$1", [id])).rows[0].count)).toBe(1);
  });
  it("an own scope, a missing grant or a stale session refuse before any write; an audit failure rolls the confirmation back", async () => {
    const id = await request();
    await expect(confirm("doctor", id, { date: DATE, time: "16:00" })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    await expect(confirm("rejecter", id, { date: DATE, time: "16:00" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", { "appointments.cancel": true }, { appointmentScope: "all" });
    await expect(requests.commandCanonicalBookingRequestConfirm(session, id, async () => ({ ok: false as const }))).rejects.toThrow(/^STAFF_OPERATION_/);
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_request_confirm_refuses CHECK (action <> 'booking_request.confirm') NOT VALID");
    try {
      await expect(confirm("desk", id, { date: DATE, time: "16:00" })).rejects.toThrow();
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_request_confirm_refuses"); }
    expect(await status(id)).toEqual({ status: "new", appointment_id: null });
    expect(Number((await fx.pool.query("SELECT count(*) FROM patients WHERE full_name=(SELECT full_name FROM booking_requests WHERE id=$1)", [id])).rows[0].count)).toBe(0);
  });
});

describe("rejection", () => {
  it("rejects with appointments.cancel alone, audited; a handled request refuses; booking grants never reject", async () => {
    const id = await request();
    await expect(requests.commandCanonicalBookingRequestReject(await fx.session("noPatients"), id)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    expect((await requests.commandCanonicalBookingRequestReject(await fx.session("rejecter"), id)).status).toBe("rejected");
    expect((await audits("booking_request.reject")).filter(row => row.entity_id === String(id)).map(row => row.actor)).toEqual(["SYN-BR-REJECT"]);
    await expect(requests.commandCanonicalBookingRequestReject(await fx.session("rejecter"), id)).rejects.toMatchObject({ code: "booking_request_handled", status: 409 });
    await expect(requests.commandCanonicalBookingRequestReject(await fx.session("doctor"), await request())).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  });
});
