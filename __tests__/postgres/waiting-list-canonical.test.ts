/** M2 slice 14: canonical waiting list (/api/waiting-list, /api/waiting-list/[id]) on
 * real PostgreSQL, synthetic data only. The appointment scope decides rows; writes are
 * one admitted `appointments.edit` transaction with the entry locked and scope-checked,
 * and the audit row atomic (the legacy best-effort audit stays on the legacy path). */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-waiting-list-2026");
const db = await import("../../lib/db");
const waiting = await import("../../lib/canonical-waiting-list");

const EDIT = { "appointments.edit": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-WL-OWNER", role: "admin" },
  reception: { username: "SYN-WL-RECEPTION", role: "reception", appointmentScope: "all", grants: EDIT },
  viewer: { username: "SYN-WL-VIEWER", role: "reception", appointmentScope: "all", grants: {} },
  doctor: { username: "SYN-WL-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", grants: EDIT },
  other: { username: "SYN-WL-OTHER", role: "doctor", doctor: true, appointmentScope: "own", grants: EDIT },
  patientsOnly: { username: "SYN-WL-PATIENTS", role: "reception", patientScope: "all", grants: EDIT },
  revoked: { username: "SYN-WL-REVOKED", role: "reception", appointmentScope: "all", grants: EDIT },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let mine = 0, theirs = 0, free = 0, service = 0, inactiveDoctor = 0;

const list = async (k: Key, history = false) => waiting.readCanonicalWaitingList(await fx.session(k), { includeResolved: false, withHistory: history });
const add = async (k: Key, body: Record<string, unknown>) => waiting.commandCanonicalWaitingAdd(await fx.session(k), waiting.parseCanonicalWaitingAdd(body));
const move = async (k: Key, id: number, body: Record<string, unknown>) => waiting.commandCanonicalWaitingMove(await fx.session(k), id, waiting.parseCanonicalWaitingMove(body));
const audits = async (id: number) => (await fx.pool.query<{ action: string; actor: string }>("SELECT action, actor FROM audit_log WHERE entity='waiting_list' AND entity_id=$1::text ORDER BY id", [id])).rows;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,'0500000000',$3) RETURNING id", [number, `SYN Waiting ${number}`, doctor])).rows[0].id;
  mine = await patient("SYN-WL-1", fx.parties.doctor!);
  theirs = await patient("SYN-WL-2", fx.parties.other!);
  free = await patient("SYN-WL-3", null);
  service = (await fx.pool.query<{ id: number }>("SELECT id FROM appointment_services ORDER BY id LIMIT 1")).rows[0]?.id
    ?? (await fx.pool.query<{ id: number }>("INSERT INTO appointment_services(code,name_ar) VALUES('syn-wl-service','خدمة تجريبية') RETURNING id")).rows[0].id;
  inactiveDoctor = (await fx.pool.query<{ id: number }>("INSERT INTO parties(name,kind,is_active) VALUES('SYN inactive doctor','doctor',false) RETURNING id")).rows[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("add and read by appointment scope", () => {
  it("adds with an atomic audit row; a duplicate need refuses; references are checked", async () => {
    const entry = await add("reception", { patientId: free, urgency: "soon", serviceId: service, note: " Synthetic note " });
    expect(entry).toMatchObject({ patientId: free, urgency: "soon", serviceId: service, note: "Synthetic note", status: "waiting" });
    expect(await audits(entry.id)).toEqual([{ action: "waiting_list.add", actor: "SYN-WL-RECEPTION" }]);
    await expect(add("reception", { patientId: free, serviceId: service })).rejects.toMatchObject({ code: "waiting_conflict", status: 409 });
    await expect(add("reception", { patientId: free, doctorId: inactiveDoctor })).rejects.toMatchObject({ code: "invalid_waiting_input", status: 400 });
    await expect(add("reception", { patientId: free, serviceId: 999_999 })).rejects.toMatchObject({ code: "invalid_waiting_input" });
    expect(() => waiting.parseCanonicalWaitingAdd({ patientId: free, urgency: "now" })).toThrow(expect.objectContaining({ code: "invalid_waiting_input" }));
  });
  it("own scope: its patients only, entries on its own party; outside equals missing", async () => {
    const own = await add("doctor", { patientId: mine });
    expect(own).toMatchObject({ patientId: mine, doctorId: fx.parties.doctor! });
    await expect(move("doctor", own.id, { action: "preferences", doctorId: "" })).rejects.toMatchObject({ code: "waiting_doctor_not_allowed", status: 403 });
    await expect(add("doctor", { patientId: mine, serviceId: service, doctorId: fx.parties.other! })).rejects.toMatchObject({ code: "waiting_doctor_not_allowed", status: 403 });
    const outside = await add("doctor", { patientId: theirs }).catch(error => error);
    const missing = await add("doctor", { patientId: 999_999 }).catch(error => error);
    expect(outside).toMatchObject({ code: "patient_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    await add("other", { patientId: theirs });
    // Own means assigned to the clinician (as for appointments): its patient's unassigned
    // entry (added by reception) is not listed.
    await add("reception", { patientId: mine, serviceId: service });
    expect((await list("doctor")).entries.map(entry => entry.id)).toEqual([own.id]);
    expect((await list("other")).entries.map(entry => entry.patientId)).toEqual([theirs]);
    expect((await list("reception")).entries).toHaveLength(4);
  });
  it("reading needs an appointment scope, not a patient scope; canEdit follows the grant", async () => {
    expect((await list("viewer")).canEdit).toBe(false);
    expect((await list("reception")).canEdit).toBe(true);
    await expect(list("patientsOnly")).rejects.toThrow(/RECORD_SCOPE_DENIED/);
    await expect(add("patientsOnly", { patientId: free, serviceId: service })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    await expect(add("viewer", { patientId: free, serviceId: service })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
  });
});

describe("entry moves", () => {
  it("contact → preferences → offer → cancel, each audited atomically; the read shows the history", async () => {
    const entry = (await list("reception")).entries.find(row => row.patientId === mine && row.serviceId === service)!;
    const contacted = await move("reception", entry.id, { action: "contact", outcome: "no_answer", channel: "phone", note: "Synthetic call" });
    expect(contacted).toMatchObject({ kind: "contact", event: { outcome: "no_answer", contactedBy: "SYN-WL-RECEPTION" } });
    expect(await move("reception", entry.id, { action: "preferences", urgency: "urgent", preferredDays: [1, 3] })).toMatchObject({ kind: "entry", entry: { urgency: "urgent", preferredDays: [1, 3] } });
    await expect(move("reception", entry.id, { action: "offer" })).rejects.toMatchObject({ code: "waiting_conflict" }); // contact already marked it offered
    const view = await waiting.readCanonicalWaitingEntry(await fx.session("reception"), entry.id);
    expect(view.events).toHaveLength(1);
    expect(await move("reception", entry.id, { action: "cancelled", reason: "Synthetic: found another clinic" })).toEqual({ kind: "ok" });
    await expect(move("reception", entry.id, { action: "expired" })).rejects.toMatchObject({ code: "waiting_conflict", status: 409 });
    expect((await audits(entry.id)).map(row => row.action)).toEqual([
      "waiting_list.add", "waiting_list.contact", "waiting_list.priority_change", "waiting_list.update_preferences", "waiting_list.resolve",
    ]);
    expect(new Set((await audits(entry.id)).map(row => row.actor))).toEqual(new Set(["SYN-WL-RECEPTION"]));
  });
  it("own scope: another doctor's entry reads and moves exactly like a missing one", async () => {
    const theirsEntry = (await list("other")).entries[0];
    const outside = await move("doctor", theirsEntry.id, { action: "offer" }).catch(error => error);
    const missing = await move("doctor", 999_999, { action: "offer" }).catch(error => error);
    expect(outside).toMatchObject({ code: "waiting_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    await expect(waiting.readCanonicalWaitingEntry(await fx.session("doctor"), theirsEntry.id)).rejects.toMatchObject({ code: "waiting_not_found" });
    expect(await audits(theirsEntry.id)).toEqual([{ action: "waiting_list.add", actor: "SYN-WL-OTHER" }]);
  });
  it("book has its own command (slice 20); booked never writes manually", () => {
    // Booking is its own command since slice 20 (appointments-canonical-waiting-book).
    expect(() => waiting.parseCanonicalWaitingMove({ action: "book", date: "2026-11-01", time: "10:00" })).toThrow(expect.objectContaining({ code: "invalid_waiting_input", status: 400 }));
    expect(() => waiting.parseCanonicalWaitingMove({ action: "booked" })).toThrow(expect.objectContaining({ code: "invalid_waiting_input", status: 400 }));
    expect(() => waiting.parseCanonicalWaitingMove({ action: "cancelled" })).toThrow(expect.objectContaining({ code: "invalid_waiting_input" }));
    expect(() => waiting.parseCanonicalWaitingMove({ action: "preferences" })).toThrow(expect.objectContaining({ code: "invalid_waiting_input" }));
  });
  it("an audit failure leaves the entry unchanged; revocation refuses the old session", async () => {
    const entry = await add("reception", { patientId: theirs, serviceId: service });
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_wl_audit_refuses CHECK (action <> 'waiting_list.contact') NOT VALID");
    try {
      await expect(move("reception", entry.id, { action: "contact", outcome: "no_answer", channel: "phone" })).rejects.toThrow();
      expect((await fx.pool.query("SELECT status FROM waiting_list WHERE id=$1", [entry.id])).rows[0].status).toBe("waiting");
      expect(Number((await fx.pool.query("SELECT count(*) FROM waiting_list_contact_events WHERE waiting_list_id=$1", [entry.id])).rows[0].count)).toBe(0);
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_wl_audit_refuses"); }
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { appointmentScope: "all" });
    await expect(waiting.commandCanonicalWaitingMove(session, entry.id, { action: "offer" })).rejects.toThrow(/^STAFF_OPERATION_/);
  });
});
