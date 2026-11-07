import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbClient } from "../../lib/db";
import type { SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";

// All records are synthetic. Only the guarded, identity-checked UUID fixture is removed.
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
let db: typeof import("../../lib/db");
let doctorId = 0;
let actor: SessionPayload;
let sequence = 0;
const TODAY = "2026-11-05";
const OLDER = "2026-10-01";
const NEWER = "2026-10-20";
const ACTOR = "synthetic-chronology-doctor";
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;

beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  db = fixture.db;
  await db.ensureSchema();
  doctorId = (await db.createParty({ name: "Synthetic chronology doctor", kind: "doctor",
    phone: null, commissionPercent: 0, note: null })).id;
  const auth = await import("../../lib/auth");
  const hash = await auth.hashPassword("synthetic-chronology-fixture-only");
  const [{ id }] = await q<{ id: number }>(`INSERT INTO users
    (username,display_name,role,password_hash,is_active,party_id)
    VALUES ($1,'Synthetic chronology doctor','doctor',$2,TRUE,$3) RETURNING id`, [ACTOR, hash, doctorId]);
  actor = { userId: id, username: ACTOR, role: "doctor", partyId: doctorId,
    credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

async function openCase(funded = false) {
  const owner = await db.createPatient({ fullName: `Synthetic chronology patient ${++sequence}`,
    phone: null, altPhone: null, gender: "unknown", birthYear: null, address: null, medicalAlert: null, note: null });
  let planId: number | null = null;
  if (funded) {
    planId = (await q<{ id: number }>(`INSERT INTO treatment_plans (patient_id,title,total_minor)
      VALUES ($1,'Synthetic chronology funded package',700000) RETURNING id`, [owner.id]))[0].id;
    await q(`INSERT INTO plan_installments (plan_id,number,due_date,amount_minor)
      VALUES ($1,1,$2::date,700000)`, [planId, NEWER]);
  }
  const result = await db.createOrthoCase({ patientId: owner.id, appliance: "fixed_metal", arches: "both",
    slot: "022", bracketSystem: null, startDate: "2026-09-01", plannedMonths: 18, planId,
    note: null, createdBy: ACTOR });
  if (!result.ok) throw new Error(result.message);
  return { patientId: owner.id, caseId: result.id };
}
type Input = Parameters<typeof db.recordAdjustment>[0];
const command = (caseId: number, doneOn: string, extra: Partial<Input> = {}): Input => ({
  caseId, visitId: null, doneOn, phase: "working", upperWire: "018 SS", lowerWire: "016 NiTi",
  elastics: "none", elasticNote: null, done: "Synthetic explicit adjustment", nextWeeks: 4,
  note: null, recordedBy: ACTOR, actorRole: "doctor", ...extra,
});
async function record(input: Input) {
  const result = await db.recordAdjustment(input);
  if (!result.ok) throw new Error(result.message);
  expect(result.created).toBe(true);
  return result;
}
const moneyTables = ["treatment_plans", "plan_installments", "plan_items", "invoices", "invoice_items", "payments",
  "patient_opening_balances"];
async function snapshot(tables: string[]) {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) result[table] = await q(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
  return result;
}
const current = (caseId: number) => db.getOrthoCase(caseId, TODAY);

// Observe a real database lock dependency instead of assuming request timing.
async function waitForCaseWaiter(holder: DbClient, holderPid: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await holder.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await holder.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
        AND $1::int = ANY(pg_blocking_pids(pid))
        AND query LIKE '%FROM ortho_cases%' AND query LIKE '%FOR UPDATE%'`, [holderPid]);
    if (rows.length === 1) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Synthetic adjustment did not wait for the held case lock");
}

describe("orthodontic current-state cache follows dated adjustment order", () => {
  it("retains newer wires, phase and follow-up when an older session is entered later", async () => {
    const { patientId, caseId } = await openCase(true);
    const first = await record(command(caseId, NEWER, { phase: "finishing", nextWeeks: 6 }));
    const original = await q("SELECT * FROM ortho_adjustments WHERE id=$1", [first.id]);
    const caseBefore = await q("SELECT * FROM ortho_cases WHERE id=$1", [caseId]);
    const moneyBefore = await snapshot(moneyTables);
    const second = await record(command(caseId, OLDER, { phase: "aligning", upperWire: "012 NiTi", lowerWire: "014 NiTi", nextWeeks: 2 }));
    const found = await current(caseId);
    expect(found).toMatchObject({ patientId, phase: "finishing", upperWire: "018 SS", lowerWire: "016 NiTi" });
    expect(found?.adjustments.map(row => row.id)).toEqual([first.id, second.id]);
    expect(found?.adjustments[1]).toMatchObject({ doneOn: OLDER, phase: "aligning", upperWire: "012 NiTi", lowerWire: "014 NiTi" });
    expect(await q("SELECT * FROM ortho_cases WHERE id=$1", [caseId])).toEqual(caseBefore);
    expect(await q("SELECT * FROM ortho_adjustments WHERE id=$1", [first.id])).toEqual(original);
    expect((await db.orthoFollowupBoard(TODAY)).find(row => row.caseId === caseId))
      .toMatchObject({ upperWire: "018 SS", lowerWire: "016 NiTi", lastAdjustmentDate: NEWER, nextWeeks: 6 });
    expect(await snapshot(moneyTables)).toEqual(moneyBefore);
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action='ortho.adjustment' AND entity_id=$1", [String(patientId)]))
      .toEqual([{ n: 2 }]);
  });

  it("uses the later ID for same-day sessions and updates for a newer day", async () => {
    const { caseId } = await openCase();
    const first = await record(command(caseId, OLDER));
    const second = await record(command(caseId, OLDER, { upperWire: "019×025 SS", phase: "finishing" }));
    expect(second.id).toBeGreaterThan(first.id);
    expect(await current(caseId)).toMatchObject({ upperWire: "019×025 SS", phase: "finishing" });
    const third = await record(command(caseId, NEWER, { upperWire: "019×025 TMA", phase: "retention" }));
    const found = await current(caseId);
    expect(found).toMatchObject({ upperWire: "019×025 TMA", phase: "retention" });
    expect(found?.adjustments.map(row => row.id)).toEqual([third.id, second.id, first.id]);
  });

  it("keeps a manually selected phase when an older session supplies a different phase", async () => {
    const { patientId, caseId } = await openCase();
    await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [patientId, doctorId]);
    await record(command(caseId, NEWER));
    expect(await db.setOrthoPhase(caseId, "finishing", { patientId, session: actor })).toBe(true);
    await record(command(caseId, OLDER, { phase: "aligning", upperWire: "012 NiTi" }));
    expect(await current(caseId)).toMatchObject({ upperWire: "018 SS", lowerWire: "016 NiTi", phase: "finishing" });
  });

  it("preserves latest blank-wire no-change and null-phase semantics", async () => {
    const { patientId, caseId } = await openCase();
    await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [patientId, doctorId]);
    await record(command(caseId, OLDER));
    expect(await db.setOrthoPhase(caseId, "finishing", { patientId, session: actor })).toBe(true);
    const result = await record(command(caseId, NEWER, { phase: null, upperWire: "  ", lowerWire: null }));
    const found = await current(caseId);
    expect(found).toMatchObject({ upperWire: "018 SS", lowerWire: "016 NiTi", phase: "finishing" });
    expect(found?.adjustments[0]).toMatchObject({ id: result.id, upperWire: "018 SS", lowerWire: "016 NiTi", phase: null });
  });

  it("does not regress current wires when signing an earlier visit now", async () => {
    const { patientId, caseId } = await openCase(true);
    await record(command(caseId, NEWER, { phase: "finishing" }));
    const visit = await db.addVisit({ patientId, patientName: "Synthetic delayed signing", patientPhone: null, note: null, doctorId });
    await q("UPDATE visits SET arrived_at=$2::timestamptz WHERE id=$1", [visit.id, `${OLDER}T12:00:00Z`]);
    const moneyBefore = await snapshot(moneyTables);
    const result = await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: ACTOR,
      signerRole: "doctor", signerDoctorPartyId: doctorId, orthoSession: { caseId, phase: "aligning",
        upperWire: "012 NiTi", lowerWire: "014 NiTi", elastics: "none", elasticNote: null,
        done: "Synthetic late documented treatment", nextWeeks: 4, note: null } });
    expect(result).toMatchObject({ reason: null, invoiceId: null, orthoBillingClass: "INCLUDED" });
    expect(await q("SELECT done_on::text,upper_wire,lower_wire,phase FROM ortho_adjustments WHERE visit_id=$1", [visit.id]))
      .toEqual([{ done_on: OLDER, upper_wire: "012 NiTi", lower_wire: "014 NiTi", phase: "aligning" }]);
    expect(await current(caseId)).toMatchObject({ phase: "finishing", upperWire: "018 SS", lowerWire: "016 NiTi" });
    expect(await snapshot(moneyTables)).toEqual(moneyBefore);
  });

  it("replays an old keyed receipt without changing current state or adding history/audit", async () => {
    const { patientId, caseId } = await openCase();
    await record(command(caseId, NEWER));
    await db.addVisit({ patientId, patientName: "Synthetic replay ownership visit", patientPhone: null,
      note: null, doctorId });
    const input = command(caseId, OLDER, { upperWire: "012 NiTi", phase: "aligning",
      request: { key: `synthetic-chronology-replay-${++sequence}`, patientId, session: actor } });
    const first = await record(input);
    expect(await current(caseId)).toMatchObject({ upperWire: "018 SS", phase: "working" });
    const before = await snapshot([...moneyTables, "ortho_cases", "ortho_adjustments", "ortho_adjustment_requests", "audit_log"]);
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false, replayed: true, id: first.id });
    expect(await snapshot([...moneyTables, "ortho_cases", "ortho_adjustments", "ortho_adjustment_requests", "audit_log"])).toEqual(before);
  });

  it.each(["assessment", "constructor"])("refuses a new non-treatment phase %s without persisting history or changing current state", async phase => {
    const { caseId } = await openCase();
    await record(command(caseId, NEWER));
    for (const doneOn of [OLDER, "2026-10-25"]) {
      const before = await snapshot([...moneyTables, "ortho_cases", "ortho_adjustments", "audit_log"]);
      expect(await db.recordAdjustment(command(caseId, doneOn, { phase: phase as Input["phase"] })))
        .toMatchObject({ ok: false });
      expect(await snapshot([...moneyTables, "ortho_cases", "ortho_adjustments", "audit_log"])).toEqual(before);
    }
  });

  it.each(["assessment", "constructor"])("refuses signing an earlier visit with phase %s atomically", async phase => {
    const { patientId, caseId } = await openCase(true);
    await record(command(caseId, NEWER));
    const visit = await db.addVisit({ patientId, patientName: "Synthetic rejected delayed signing",
      patientPhone: null, note: null, doctorId });
    await q("UPDATE visits SET arrived_at=$2::timestamptz WHERE id=$1", [visit.id, `${OLDER}T12:00:00Z`]);
    const tables = [...moneyTables, "visits", "visit_procedures", "ortho_cases", "ortho_adjustments", "audit_log"];
    const before = await snapshot(tables);
    expect(await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: ACTOR,
      signerRole: "doctor", signerDoctorPartyId: doctorId, orthoSession: { caseId,
        phase: phase as Input["phase"], upperWire: "012 NiTi", lowerWire: "014 NiTi", elastics: "none",
        elasticNote: null, done: "Synthetic invalid phase sign attempt", nextWeeks: 4, note: null } }))
      .toMatchObject({ reason: "ortho_case_invalid", invoiceId: null });
    expect(await snapshot(tables)).toEqual(before);
  });

  it.each(["assessment", "constructor"])("preserves exact visit replay after closure despite stale incoming phase %s", async phase => {
    const { patientId, caseId } = await openCase();
    const visit = await db.addVisit({ patientId, patientName: "Synthetic closed replay visit",
      patientPhone: null, note: null, doctorId });
    const input = command(caseId, NEWER, { visitId: visit.id });
    const first = await record(input);
    expect(await db.closeOrthoCase({ id: caseId, status: "discontinued", actor: ACTOR,
      note: "Synthetic closed replay" })).toEqual({ ok: true });
    const tables = [...moneyTables, "visits", "ortho_cases", "ortho_adjustments", "audit_log"];
    const before = await snapshot(tables);
    expect(await db.recordAdjustment({ ...input, phase: phase as Input["phase"] }))
      .toMatchObject({ ok: true, created: false, id: first.id, visitId: visit.id });
    expect(await snapshot(tables)).toEqual(before);
  });

  it("keeps existing blank historical-wire fallback without presenting it as recovered history", async () => {
    const { caseId } = await openCase();
    await record(command(caseId, NEWER, { phase: "finishing" }));
    const caseBefore = await q("SELECT * FROM ortho_cases WHERE id=$1", [caseId]);
    const older = await record(command(caseId, OLDER, { phase: null, upperWire: null, lowerWire: " " }));
    expect(await q("SELECT * FROM ortho_cases WHERE id=$1", [caseId])).toEqual(caseBefore);
    // The pre-existing writer substitutes current wires for omitted values.
    // This assertion preserves that contract, not a claim of historical accuracy.
    expect((await current(caseId))?.adjustments.find(row => row.id === older.id))
      .toMatchObject({ doneOn: OLDER, upperWire: "018 SS", lowerWire: "016 NiTi", phase: null });
  });

  it("decides chronology only after acquiring the case lock", async () => {
    const { caseId } = await openCase();
    const holder = await db.getPool().connect();
    let pending: ReturnType<typeof record> | undefined;
    let holding = false;
    try {
      await holder.query("BEGIN"); holding = true;
      await holder.query("SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE", [caseId]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = record(command(caseId, OLDER, { phase: "aligning", upperWire: "012 NiTi" }));
      void pending.catch(() => undefined);
      expect(await waitForCaseWaiter(holder, holderPid)).not.toBe(holderPid);
      // The locked writer has not yet inspected case state. Model another valid
      // committed newer session without weakening constraints or changing old rows.
      await holder.query(`INSERT INTO ortho_adjustments
        (case_id,done_on,phase,upper_wire,lower_wire,done,recorded_by)
        VALUES ($1,$2::date,'finishing','019×025 SS','018 SS','Synthetic newer race session',$3)`, [caseId, NEWER, ACTOR]);
      await holder.query("UPDATE ortho_cases SET upper_wire='019×025 SS',lower_wire='018 SS',phase='finishing' WHERE id=$1", [caseId]);
      await holder.query("COMMIT"); holding = false;
      await pending;
      expect(await current(caseId)).toMatchObject({ upperWire: "019×025 SS", lowerWire: "018 SS", phase: "finishing" });
      expect((await current(caseId))?.adjustments).toHaveLength(2);
    } finally {
      if (holding) await holder.query("ROLLBACK");
      holder.release();
      if (pending) await Promise.allSettled([pending]);
    }
  }, 25_000);
});
