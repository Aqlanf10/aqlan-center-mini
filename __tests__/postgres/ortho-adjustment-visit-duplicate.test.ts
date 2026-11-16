// Review finding on #483 (6871207083): a second, different session request in a visit that already has a
// session must not be reported as saved. Real PostgreSQL and the real POST /api/ortho/[id] route; only the
// framework markers are stubbed. Synthetic data only. The one-session-per-visit rule is preserved.
vi.mock("server-only", () => ({}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_adjustment_visit_duplicate_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { clinicDateString } = await import("../../lib/schedule");
const { POST } = await import("../../app/api/ortho/[id]/route");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let serial = 0;
const today = () => clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

beforeAll(async () => {
  await db.ensureSchema();
  const passwordHash = await auth.hashPassword("synthetic-visit-duplicate");
  const [{ id }] = await q<{ id: number }>(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES ('syn-visit-dup','SYN visit duplicate',$1,'admin') RETURNING id`, [passwordHash]);
  context.token = auth.createSessionToken({ userId: id, username: "syn-visit-dup", role: "admin",
    expiresAt: Date.now() + 3_600_000, credentialVersion: auth.sessionCredentialVersion(passwordHash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture() {
  const [patient] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN visit duplicate') RETURNING id", [`SYN-VDUP-${++serial}`]);
  const created = await db.createOrthoCase({ patientId: patient.id, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: "syn-visit-dup" });
  if (!created.ok) throw new Error(created.message);
  const [visit] = await q<{ id: number }>(`INSERT INTO visits(patient_id,patient_name,status,arrived_at)
    VALUES($1,'SYN visit duplicate','in_chair',now()) RETURNING id`, [patient.id]);
  return { patientId: patient.id, caseId: created.id, visitId: visit.id };
}
const first = { upperWire: "016 NiTi", lowerWire: "", elastics: "class_ii", elasticNote: "SYN first", done: "SYN first session", nextWeeks: 4, auxiliaries: ["tpa"] };
const second = { upperWire: "019×025 SS", lowerWire: "014 NiTi", elastics: "none", elasticNote: "", done: "SYN second intention", nextWeeks: 8, auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" };
function send(caseId: number, key: string, body: object) {
  return POST(new Request(`https://synthetic.invalid/api/ortho/${caseId}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ doneOn: today(), ...body }),
  }), { params: Promise.resolve({ id: String(caseId) }) });
}
const state = async (caseId: number) => ({
  adjustments: await q(`SELECT id, visit_id, upper_wire, lower_wire, elastics, done, next_weeks, auxiliaries, auxiliary_other
    FROM ortho_adjustments WHERE case_id=$1 ORDER BY id`, [caseId]),
  receipts: await q("SELECT request_key, adjustment_id FROM ortho_adjustment_requests WHERE case_id=$1 ORDER BY request_key", [caseId]),
  wires: await q("SELECT upper_wire, lower_wire FROM ortho_cases WHERE id=$1", [caseId]),
  audits: (await q<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action='ortho.adjustment'"))[0].n,
});

describe("a second, different request in a visit that already has a session", () => {
  it("is refused with the existing session named, and nothing about it is recorded", async () => {
    const f = await fixture();
    const saved = await send(f.caseId, "syn-vdup-first-intent-1", first);
    expect(saved.status).toBe(201);
    const receipt = await saved.json();
    expect(receipt).toMatchObject({ visitId: f.visitId, attachedToToday: true });
    const before = await state(f.caseId);

    const refused = await send(f.caseId, "syn-vdup-second-intent", second);
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body).toMatchObject({ code: "adjustment_visit_already_recorded", existingAdjustmentId: receipt.id, visitId: f.visitId });
    expect(body.message).toMatch(/لم تُحفظ/);
    expect(body).not.toHaveProperty("id");
    // The first session, its receipt, the case wires and the audit are exactly as they were.
    expect(await state(f.caseId)).toEqual(before);
    expect(before.adjustments).toEqual([expect.objectContaining({ upper_wire: "016 NiTi", done: "SYN first session", next_weeks: 4, auxiliaries: ["tpa"] })]);
    expect(before.receipts).toEqual([{ request_key: "syn-vdup-first-intent-1", adjustment_id: receipt.id }]);

    // The refused key stays unused: sending it again is refused again, not replayed as saved.
    expect((await send(f.caseId, "syn-vdup-second-intent", second)).status).toBe(409);
    // Identical-content new intent is still a new intent, not a retry.
    expect((await send(f.caseId, "syn-vdup-same-content-2", first)).status).toBe(409);
    expect(await state(f.caseId)).toEqual(before);
  });

  it("still replays the original key and still refuses a changed payload under it", async () => {
    const f = await fixture();
    const saved = await send(f.caseId, "syn-vdup-replay-key-001", first); expect(saved.status).toBe(201);
    const id = (await saved.json()).id; const before = await state(f.caseId);
    const replay = await send(f.caseId, "syn-vdup-replay-key-001", first);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id, existing: true, replayed: true });
    const changed = await send(f.caseId, "syn-vdup-replay-key-001", second);
    expect(changed.status).toBe(409); expect((await changed.json()).code).toBe("adjustment_request_conflict");
    expect(await state(f.caseId)).toEqual(before);
  });

  it("serializes two different concurrent intentions to one saved session and one refusal", async () => {
    const f = await fixture();
    const results = await Promise.all([send(f.caseId, "syn-vdup-race-intent-a", first), send(f.caseId, "syn-vdup-race-intent-b", second)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const after = await state(f.caseId);
    expect(after.adjustments).toHaveLength(1);
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0].adjustment_id).toBe(after.adjustments[0].id);
  });
});
