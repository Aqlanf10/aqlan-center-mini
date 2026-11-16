// Follow-up review on #483 (6872647524): receipts written before the same-visit fix could bind request B
// (its own hash) to session A recorded from different values. A synthetic upgrade fixture, not evidence
// that such rows exist. Real PostgreSQL and the real POST /api/ortho/[id] route; synthetic data only.
vi.mock("server-only", () => ({}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { adjustmentRequestHash } from "../../lib/ortho-adjustment-request-hash";
import { parseAuxiliariesInput } from "../../lib/ortho-auxiliaries";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_adjustment_legacy_receipt_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { clinicDateString } = await import("../../lib/schedule");
const { POST } = await import("../../app/api/ortho/[id]/route");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let serial = 0, actorId = 0;
const today = () => clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

beforeAll(async () => {
  await db.ensureSchema();
  const passwordHash = await auth.hashPassword("synthetic-legacy-receipt");
  [{ id: actorId }] = await q<{ id: number }>(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES ('syn-legacy-receipt','SYN legacy receipt',$1,'admin') RETURNING id`, [passwordHash]);
  context.token = auth.createSessionToken({ userId: actorId, username: "syn-legacy-receipt", role: "admin",
    expiresAt: Date.now() + 3_600_000, credentialVersion: auth.sessionCredentialVersion(passwordHash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture() {
  const [patient] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN legacy receipt') RETURNING id", [`SYN-LREC-${++serial}`]);
  const created = await db.createOrthoCase({ patientId: patient.id, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: "syn-legacy-receipt" });
  if (!created.ok) throw new Error(created.message);
  const [visit] = await q<{ id: number }>(`INSERT INTO visits(patient_id,patient_name,status,arrived_at)
    VALUES($1,'SYN legacy receipt','in_chair',now()) RETURNING id`, [patient.id]);
  return { patientId: patient.id, caseId: created.id, visitId: visit.id };
}
type Body = { upperWire: string; lowerWire: string; elastics: string; elasticNote: string; done: string; nextWeeks: number;
  auxiliaries?: string[]; auxiliaryOther?: string };
const A: Body = { upperWire: "016 NiTi", lowerWire: "", elastics: "class_ii", elasticNote: "SYN A", done: "SYN session A", nextWeeks: 4, auxiliaries: ["tpa"] };
const B: Body = { upperWire: "019×025 SS", lowerWire: "014 NiTi", elastics: "none", elasticNote: "", done: "SYN request B", nextWeeks: 8,
  auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" };
function send(caseId: number, key: string, body: Body) {
  return POST(new Request(`https://synthetic.invalid/api/ortho/${caseId}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ doneOn: today(), ...body }),
  }), { params: Promise.resolve({ id: String(caseId) }) });
}
/** The receipt the pre-fix writer stored for B in A's visit: B's own fingerprint, A's session id. */
async function legacyReceipt(f: Awaited<ReturnType<typeof fixture>>, key: string, body: Body, adjustmentId: number) {
  const text = (value: string) => value.trim() || null;
  const aux = parseAuxiliariesInput(body as unknown as Record<string, unknown>);
  if (!aux.ok) throw new Error(aux.message);
  const input = { caseId: f.caseId, visitId: null, doneOn: today(), phase: null, upperWire: text(body.upperWire), lowerWire: text(body.lowerWire),
    elastics: body.elastics as "none", elasticNote: text(body.elasticNote), done: text(body.done), nextWeeks: body.nextWeeks, note: null,
    recordedBy: "syn-legacy-receipt", actorRole: "admin", ...(aux.value.auxiliaries === null ? {} : aux.value) };
  await q(`INSERT INTO ortho_adjustment_requests(actor_user_id,request_key,request_hash,patient_id,case_id,adjustment_id,visit_id,attached_to_today)
    VALUES($1,$2,$3,$4,$5,$6,$7,TRUE)`, [actorId, key, adjustmentRequestHash(actorId, f.patientId, input, today()), f.patientId, f.caseId, adjustmentId, f.visitId]);
}
const state = async (caseId: number) => ({
  adjustments: await q(`SELECT id, upper_wire, lower_wire, elastics, elastic_note, done, next_weeks, auxiliaries, auxiliary_other
    FROM ortho_adjustments WHERE case_id=$1 ORDER BY id`, [caseId]),
  receipts: await q("SELECT request_key, request_hash, adjustment_id, created_at FROM ortho_adjustment_requests WHERE case_id=$1 ORDER BY request_key", [caseId]),
  wires: await q("SELECT upper_wire, lower_wire FROM ortho_cases WHERE id=$1", [caseId]),
  documents: (await q<{ n: number }>("SELECT count(*)::int AS n FROM patient_documents d JOIN ortho_adjustments a ON a.id=d.adjustment_id WHERE a.case_id=$1", [caseId]))[0].n,
  audits: (await q<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action='ortho.adjustment'"))[0].n,
});

describe("receipts that bind a request to a session recorded from other values", () => {
  it("are not replayed as saved, and nothing historical is rewritten or deleted", async () => {
    const f = await fixture();
    const saved = await send(f.caseId, "syn-lrec-session-a-01", A); expect(saved.status).toBe(201);
    const a = (await saved.json()).id;
    await legacyReceipt(f, "syn-lrec-request-b-01", B, a);
    const before = await state(f.caseId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await send(f.caseId, "syn-lrec-request-b-01", B);
      expect(retry.status).toBe(409);
      const body = await retry.json();
      expect(body).toMatchObject({ code: "adjustment_receipt_bound_to_other_session", existingAdjustmentId: a, visitId: f.visitId });
      expect(body).not.toHaveProperty("replayed");
      expect(body.message).toMatch(/لم يُعتبر محفوظًا/);
    }
    // The historical session, both receipts (B's included), the case wires, documents and audit are untouched.
    expect(await state(f.caseId)).toEqual(before);
    // A's own key still replays A, a genuinely saved request.
    const replay = await send(f.caseId, "syn-lrec-session-a-01", A);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id: a, replayed: true });
    // A changed payload under B's key is still a payload conflict, and a new key is still the same-visit refusal.
    expect((await (await send(f.caseId, "syn-lrec-request-b-01", A)).json()).code).toBe("adjustment_request_conflict");
    expect((await (await send(f.caseId, "syn-lrec-request-c-01", B)).json()).code).toBe("adjustment_visit_already_recorded");
    expect(await state(f.caseId)).toEqual(before);
  });

  it("refuses a legacy binding to a session that has no receipt of its own (recorded at visit signing)", async () => {
    const f = await fixture();
    const [{ id: a }] = await q<{ id: number }>(`INSERT INTO ortho_adjustments(case_id,visit_id,done_on,upper_wire,elastics,done,next_weeks,recorded_by)
      VALUES($1,$2,$3,'016 NiTi','class_ii','SYN signed session',4,'syn-legacy-receipt') RETURNING id`, [f.caseId, f.visitId, today()]);
    await legacyReceipt(f, "syn-lrec-request-b-02", B, a);
    const before = await state(f.caseId);
    const retry = await send(f.caseId, "syn-lrec-request-b-02", B);
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe("adjustment_receipt_bound_to_other_session");
    expect(await state(f.caseId)).toEqual(before);
  });

  it("still replays a legacy binding whose recorded values are exactly the request's (indistinguishable, nothing misleading)", async () => {
    const f = await fixture();
    const a = (await (await send(f.caseId, "syn-lrec-session-a-03", A)).json()).id;
    await legacyReceipt(f, "syn-lrec-request-same-03", A, a);
    const replay = await send(f.caseId, "syn-lrec-request-same-03", A);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id: a, replayed: true });
  });

  it("still replays a genuinely saved request that left a wire unchanged (blank wire keeps the case wire)", async () => {
    const f = await fixture();
    const blank: Body = { ...A, upperWire: "", lowerWire: "", auxiliaries: [] };
    const saved = await send(f.caseId, "syn-lrec-blank-wire-04", blank); expect(saved.status).toBe(201);
    const id = (await saved.json()).id;
    const replay = await send(f.caseId, "syn-lrec-blank-wire-04", blank);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id, replayed: true });
  });
});
