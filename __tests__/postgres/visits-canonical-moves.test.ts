/** M2 slice 12: canonical queue moves (PATCH /api/visits/[id]) on real PostgreSQL,
 * synthetic data only. One admitted `visits.manage` transaction per move, the legacy
 * lock order (chair-day lock, then the visit row), the visit inside the actor's current
 * scope (outside = missing), the readiness gate unchanged, the audit row atomic. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-visit-moves-2026");
const db = await import("../../lib/db");
const visits = await import("../../lib/canonical-visits");
const { CLEARANCE_WARNING } = await import("../../lib/chair-readiness");

const MANAGE = { "visits.manage": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-M-OWNER", role: "admin" },
  reception: { username: "SYN-M-RECEPTION", role: "reception", patientScope: "all", grants: MANAGE },
  viewer: { username: "SYN-M-VIEWER", role: "reception", patientScope: "all", grants: {} },
  doctor: { username: "SYN-M-DOCTOR", role: "doctor", doctor: true, patientScope: "own", grants: MANAGE },
  other: { username: "SYN-M-OTHER", role: "doctor", doctor: true, patientScope: "own", grants: MANAGE },
  revoked: { username: "SYN-M-REVOKED", role: "reception", patientScope: "all", grants: MANAGE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let mine = 0;

const move = async (k: Key, id: number, body: Record<string, unknown>) =>
  visits.commandCanonicalVisitMove(await fx.session(k), id, visits.parseCanonicalVisitMove(body));
const visit = async (name: string, patientId: number | null, doctorId: number | null) =>
  (await fx.pool.query<{ id: number }>("INSERT INTO visits(patient_name,patient_id,doctor_id) VALUES($1,$2,$3) RETURNING id", [name, patientId, doctorId])).rows[0].id;
const state = async (id: number) => (await fx.pool.query("SELECT status, chair, no_response_count FROM visits WHERE id=$1", [id])).rows[0];
const audits = async (id: number) => (await fx.pool.query<{ action: string; actor: string }>("SELECT action, actor FROM audit_log WHERE entity='visit' AND entity_id=$1::text ORDER BY id", [id])).rows;
const setting = (key: string, value: string) => fx.pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  mine = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-M-1','SYN Moves 1','0500000000',$1) RETURNING id", [fx.parties.doctor!])).rows[0].id;
  await setting("ops.require_clearance_before_call", "false");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("the queue journey through the canonical runtime", () => {
  it("call → call again → return → call → seat → finish, each with its audit row under the canonical actor", async () => {
    const appointment = (await fx.pool.query<{ id: number }>("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES($1,CURRENT_DATE,'09:00','arrived') RETURNING id", [mine])).rows[0].id;
    const id = (await fx.pool.query<{ id: number }>("INSERT INTO visits(patient_name,patient_id,appointment_id) VALUES('SYN Moves 1',$1,$2) RETURNING id", [mine, appointment])).rows[0].id;
    expect(await move("reception", id, { action: "call", chair: 1 })).toMatchObject({ kind: "visit", visit: { status: "called", chair: 1 }, warning: CLEARANCE_WARNING });
    expect(await move("reception", id, { action: "call_again" })).toMatchObject({ visit: { status: "called" } });
    expect(await move("reception", id, { action: "return" })).toMatchObject({ visit: { status: "waiting", chair: null } });
    expect((await state(id)).no_response_count).toBe(1);
    await move("reception", id, { action: "call", chair: 1 });
    expect(await move("reception", id, { action: "seat", chair: 1 })).toMatchObject({ visit: { status: "in_chair", chair: 1 } });
    expect(await move("reception", id, { action: "finish" })).toMatchObject({ visit: { status: "done" } });
    expect((await fx.pool.query("SELECT status FROM appointments WHERE id=$1", [appointment])).rows[0].status).toBe("done");
    expect((await audits(id)).map(row => [row.action, row.actor])).toEqual([
      ["visit.call", "SYN-M-RECEPTION"], ["visit.call_again", "SYN-M-RECEPTION"], ["visit.return_to_waiting", "SYN-M-RECEPTION"],
      ["visit.call", "SYN-M-RECEPTION"], ["visit.seat", "SYN-M-RECEPTION"], ["visit.finish", "SYN-M-RECEPTION"],
    ]);
    await expect(move("reception", id, { action: "finish" })).rejects.toMatchObject({ code: "visit_move_conflict", status: 409 });
  });
});

describe("scope and admission", () => {
  it("own scope moves its own patients' and assigned visits; another visit reads exactly like a missing one", async () => {
    const own = await visit("SYN own patient", mine, null);
    const assigned = await visit("SYN assigned walk-in", null, fx.parties.doctor!);
    const theirs = await visit("SYN other walk-in", null, fx.parties.other!);
    expect(await move("doctor", own, { action: "call", chair: 2 })).toMatchObject({ visit: { status: "called" } });
    expect(await move("doctor", assigned, { action: "finish" })).toMatchObject({ visit: { status: "done" } });
    const outside = await move("doctor", theirs, { action: "finish" }).catch(error => error);
    const missing = await move("doctor", 999_999, { action: "finish" }).catch(error => error);
    expect(outside).toMatchObject({ code: "visit_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    expect((await state(theirs)).status).toBe("waiting");
    expect(await audits(theirs)).toEqual([]);
    // A call to a missing visit answers 404 too (never the chair conflict).
    await expect(move("doctor", 999_999, { action: "call", chair: 3 })).rejects.toMatchObject({ code: "visit_not_found" });
    await move("doctor", own, { action: "return" });
  });
  it("no visits.manage, a stale session after revocation, and the not-yet-canonical actions refuse", async () => {
    const id = await visit("SYN admission", null, null);
    await expect(move("viewer", id, { action: "finish" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { patientScope: "all" });
    await expect(visits.commandCanonicalVisitMove(session, id, visits.parseCanonicalVisitMove({ action: "finish" }))).rejects.toThrow(/^STAFF_OPERATION_/);
    for (const action of ["defer", "link", "open_file"]) {
      expect(() => visits.parseCanonicalVisitMove({ action })).toThrow(expect.objectContaining({ code: "visit_action_not_canonical", status: 409 }));
    }
    expect(() => visits.parseCanonicalVisitMove({ action: "call", chair: 0 })).toThrow(expect.objectContaining({ code: "invalid_visit_input" }));
    expect(() => visits.parseCanonicalVisitMove({ action: "teleport" })).toThrow(expect.objectContaining({ code: "invalid_visit_input" }));
    expect((await state(id)).status).toBe("waiting");
  });
});

describe("chairs, gate and atomicity", () => {
  it("two concurrent calls to the same chair: exactly one wins; the loser writes nothing", async () => {
    const a = await visit("SYN race A", null, null);
    const b = await visit("SYN race B", null, null);
    const results = await Promise.allSettled([move("reception", a, { action: "call", chair: 4 }), move("reception", b, { action: "call", chair: 4 })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "visit_move_conflict", status: 409 });
    const loser = (await state(a)).status === "called" ? b : a;
    expect(await state(loser)).toMatchObject({ status: "waiting", chair: null });
    expect(await audits(loser)).toEqual([]);
  });
  it("the readiness gate: refused without clearance, emergency needs a written reason (audited), clear lifts it", async () => {
    await setting("ops.require_clearance_before_call", "true");
    try {
      const id = await visit("SYN gated", null, null);
      await expect(move("reception", id, { action: "call", chair: 5 })).rejects.toMatchObject({ code: "clearance_required", status: 409 });
      await expect(move("reception", id, { action: "call", chair: 5, emergency: true })).rejects.toMatchObject({ code: "emergency_reason_required" });
      expect((await state(id)).status).toBe("waiting");
      expect(await move("reception", id, { action: "call", chair: 5, emergency: true, emergencyReason: "Synthetic acute pain" })).toMatchObject({ visit: { status: "called" } });
      expect((await audits(id)).map(row => row.action)).toEqual(["visit.call", "visit.clearance_bypass"]);
      await move("reception", id, { action: "return" });

      const cleared = await visit("SYN cleared", null, null);
      expect(await move("reception", cleared, { action: "clear" })).toMatchObject({ kind: "cleared", clearedBy: "SYN-M-RECEPTION", already: false });
      expect(await move("reception", cleared, { action: "clear" })).toMatchObject({ kind: "cleared", already: true });
      expect(await move("reception", cleared, { action: "call", chair: 6 })).toMatchObject({ visit: { status: "called" }, warning: null });
    } finally { await setting("ops.require_clearance_before_call", "false"); }
  });
  it("an audit failure leaves the visit where it was", async () => {
    const id = await visit("SYN audit refused", null, null);
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_move_audit_refuses CHECK (actor <> 'SYN-M-RECEPTION') NOT VALID");
    try {
      await expect(move("reception", id, { action: "call", chair: 7 })).rejects.toThrow();
      expect(await state(id)).toMatchObject({ status: "waiting", chair: null });
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_move_audit_refuses"); }
  });
});
