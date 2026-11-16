import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbClient, DbPool } from "../../lib/db";
import type { SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";

/**
 * Synthetic real-writer history regressions, in a guarded UUID PostgreSQL database.
 * No fixed database reset, disabled constraints, live patients, or finance-engine changes.
 * SQL adjustment inserts model only legacy rows that current writers must not create.
 */
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
let db: typeof import("../../lib/db");
let doctorId = 0;
let actorSession: SessionPayload;
let sequence = 0;
const DAY = "2026-10-01";
const ACTOR = "synthetic-visit-history-doctor";
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;

beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  db = fixture.db;
  await db.ensureSchema();
  doctorId = (await db.createParty({ name: "Synthetic visit history doctor", kind: "doctor",
    phone: null, commissionPercent: 0, note: null })).id;
  const auth = await import("../../lib/auth");
  const hash = await auth.hashPassword("synthetic-history-replay-only");
  const [{ id }] = await q<{ id: number }>(`INSERT INTO users
    (username,display_name,role,password_hash,is_active,party_id)
    VALUES ($1,'Synthetic history doctor','doctor',$2,TRUE,$3) RETURNING id`, [ACTOR, hash, doctorId]);
  actorSession = { userId: id, username: ACTOR, role: "doctor", partyId: doctorId,
    credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

async function patient() {
  return db.createPatient({ fullName: `Synthetic visit history patient ${++sequence}`, phone: null,
    altPhone: null, gender: "unknown", birthYear: null, address: null, medicalAlert: null, note: null });
}
async function visit(patientId: number | null, documented = false) {
  const opened = await db.addVisit({ patientId, patientName: `Synthetic history visit ${++sequence}`,
    patientPhone: null, note: null, doctorId });
  if (documented) {
    expect(await db.saveClinicalNotes({ visitId: opened.id, chiefComplaint: null, examination: null,
      diagnosis: "Synthetic clinical review", treatmentDone: null, nextPlan: null, doctorId })).toBe(true);
  }
  return opened.id;
}
async function openCase(patientId: number, funded = false) {
  let planId: number | null = null;
  if (funded) {
    // The same explicit installment fixture used by ortho-package.test.ts.
    planId = (await q<{ id: number }>(`INSERT INTO treatment_plans (patient_id,title,total_minor)
      VALUES ($1,'Synthetic history funded package',900000) RETURNING id`, [patientId]))[0].id;
    await q(`INSERT INTO plan_installments (plan_id,number,due_date,amount_minor)
      VALUES ($1,1,$2::date,900000)`, [planId, DAY]);
  }
  const opened = await db.createOrthoCase({ patientId, appliance: "fixed_metal", arches: "both",
    slot: "022", bracketSystem: null, startDate: DAY, plannedMonths: 18, planId, note: null, createdBy: ACTOR });
  if (!opened.ok) throw new Error(opened.message);
  return opened.id;
}
async function closeCase(caseId: number, status: "completed" | "discontinued" = "discontinued") {
  if (status === "completed") {
    const [{ patient_id: patientId }] = await q<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [caseId]);
    expect(await db.setRetainer({ id: caseId, retainer: "hawley", deliveredOn: DAY }, { patientId, session: actorSession })).toBe(true);
  }
  expect(await db.closeOrthoCase({ id: caseId, status, actor: ACTOR,
    note: "Synthetic history closure" })).toEqual({ ok: true });
}
const session = (caseId: number) => ({ caseId, phase: "working" as const, upperWire: "016 NiTi",
  lowerWire: null, elastics: "none" as const, elasticNote: null, done: "Synthetic history adjustment",
  nextWeeks: 4, note: null });
const record = (caseId: number, visitId: number) => db.recordAdjustment({ ...session(caseId), visitId,
  doneOn: DAY, recordedBy: ACTOR, actorRole: "doctor" });
async function adjustment(caseId: number, visitId: number) {
  const saved = await record(caseId, visitId);
  if (!saved.ok) throw new Error(saved.message);
  expect(saved).toMatchObject({ created: true, visitId });
  return saved.id;
}
const sign = (visitId: number, extra: Partial<Parameters<typeof db.signClinicalVisit>[0]> = {}) =>
  db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: ACTOR, signerRole: "doctor",
    signerDoctorPartyId: doctorId, ...extra });

const financeTables = ["treatment_plans", "plan_items", "plan_installments", "invoices", "invoice_items",
  "payments", "patient_opening_balances"] as const;
const footprintTables = ["patients", "visits", "visit_procedures", "clinical_cases", "ortho_cases",
  "ortho_adjustments", "ortho_adjustment_requests", "tooth_conditions", "planned_visits", "treatment_sessions",
  "lab_orders", "inventory_movements", ...financeTables, "audit_log"] as const;
async function snapshot(tables: readonly string[], runner: Pick<DbClient | DbPool, "query"> = db.getPool()) {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    // All identifiers come from the fixed lists above. Full rows catch updates as well as inserts.
    result[table] = (await runner.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.row);
  }
  return result;
}
const footprint = (runner?: Pick<DbClient | DbPool, "query">) => snapshot(footprintTables, runner);
async function legacyAdjustment(caseId: number, visitId: number, runner: Pick<DbClient | DbPool, "query"> = db.getPool()) {
  return (await runner.query<{ id: number }>(`INSERT INTO ortho_adjustments
    (case_id,visit_id,done_on,done,recorded_by)
    VALUES ($1,$2,$3::date,'Synthetic intentionally inconsistent legacy adjustment',$4) RETURNING id`,
  [caseId, visitId, DAY, ACTOR])).rows[0].id;
}

async function historicalVisit() {
  const owner = await patient();
  const caseA = await openCase(owner.id);
  const visitId = await visit(owner.id);
  const adjustmentId = await adjustment(caseA, visitId);
  return { owner, caseA, visitId, adjustmentId };
}

// The holder owns the visit lock. A lock wait, not elapsed time, proves the signer's
// read-only projection has finished and its transaction is now waiting to revalidate.
async function waitForVisitLock(holder: DbClient, holderPid: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await holder.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await holder.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND state = 'active' AND wait_event_type = 'Lock'
        AND $1::int = ANY(pg_blocking_pids(pid))
        AND query LIKE '%FROM visits%' AND query LIKE '%signed_at IS NULL FOR UPDATE%'`, [holderPid]);
    if (rows.length === 1) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const activity = (await holder.query(`SELECT pid,state,wait_event_type,query,pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`)).rows;
  throw new Error(`Synthetic visit signer did not reach the held row lock: ${JSON.stringify(activity)}`);
}

describe("orthodontic visit history is scoped to recorded work, not today's open case", () => {
  // Merged main-line classification: a new orthodontic case without a funded plan is REVIEW_REQUIRED
  // (an explicit billing decision is pending), not OUTSIDE_CONTRACT, which is kept for per-session legacy cases.
  it.each(["completed", "discontinued"] as const)("retains case A after it is %s and signs adjustment-only work without an invoice", async status => {
    const { caseA, visitId, adjustmentId } = await historicalVisit();
    await closeCase(caseA, status);
    const beforeRead = await footprint();
    expect(await db.getClinicalVisit(visitId)).toMatchObject({ status: "open", diagnosis: null,
      treatmentDone: null, procedures: [], ortho: { caseId: caseA, visitAdjustmentId: adjustmentId,
        adjustmentBillingClass: "REVIEW_REQUIRED" } });
    expect(await db.previewVisitBilling(visitId)).toMatchObject({ orthoAdjustment: "REVIEW_REQUIRED" });
    expect(await footprint()).toEqual(beforeRead);

    const moneyBefore = await snapshot(financeTables);
    expect(await sign(visitId)).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0,
      orthoBillingClass: "REVIEW_REQUIRED", visit: { status: "signed",
        ortho: { caseId: caseA, visitAdjustmentId: adjustmentId } } });
    expect(await snapshot(financeTables)).toEqual(moneyBefore);
    expect(await q("SELECT id FROM ortho_adjustments WHERE visit_id=$1 ORDER BY id", [visitId]))
      .toEqual([{ id: adjustmentId }]);
  });

  it.each([null, "no_charge"] as const)("keeps signed A's frozen billing (%s) after funded case B opens", async decision => {
    const { owner, caseA, visitId, adjustmentId } = await historicalVisit();
    const extra = decision === "no_charge"
      ? { outsideContractDecision: { decision: "no_charge" as const, reason: "Synthetic documented no-charge decision" } }
      : {};
    expect(await sign(visitId, extra)).toMatchObject({ reason: null, invoiceId: null,
      orthoBillingClass: "REVIEW_REQUIRED", orthoBillingDecision: decision });
    const frozen = await q("SELECT * FROM ortho_adjustments WHERE id=$1", [adjustmentId]);
    await closeCase(caseA);
    const caseB = await openCase(owner.id, true);
    expect(caseB).not.toBe(caseA);
    expect(await db.orthoAdjustmentBillingClass(db.getPool(), caseB, owner.id)).toBe("INCLUDED");

    const before = await footprint();
    const expected = decision === "no_charge" ? "NO_CHARGE" : "REVIEW_REQUIRED";
    expect(await db.getClinicalVisit(visitId)).toMatchObject({ status: "signed", ortho: {
      caseId: caseA, visitAdjustmentId: adjustmentId, adjustmentBillingClass: expected } });
    expect(await db.previewVisitBilling(visitId)).toMatchObject({ orthoAdjustment: expected });
    expect(await q("SELECT * FROM ortho_adjustments WHERE id=$1", [adjustmentId])).toEqual(frozen);
    expect(await sign(visitId)).toMatchObject({ reason: "already_signed", invoiceId: null });
    expect(await footprint()).toEqual(before);
  });

  it("does not attach a later funded case to a signed visit with no recorded adjustment", async () => {
    const owner = await patient();
    const visitId = await visit(owner.id, true);
    expect(await sign(visitId)).toMatchObject({ reason: null, invoiceId: null, orthoBillingClass: null });
    await openCase(owner.id, true);
    const before = await footprint();
    expect(await db.getClinicalVisit(visitId)).toMatchObject({ status: "signed", ortho: null });
    expect(await db.previewVisitBilling(visitId)).toMatchObject({ orthoAdjustment: null });
    expect(await footprint()).toEqual(before);
  });

  it("keeps the active-case fallback for an unsigned visit with no recorded adjustment", async () => {
    const owner = await patient();
    const caseB = await openCase(owner.id, true);
    const visitId = await visit(owner.id);
    const before = await footprint();
    expect(await db.getClinicalVisit(visitId)).toMatchObject({ status: "open", ortho: {
      caseId: caseB, visitAdjustmentId: null, adjustmentBillingClass: "INCLUDED" } });
    expect(await db.previewVisitBilling(visitId)).toMatchObject({ orthoAdjustment: "INCLUDED" });
    expect(await footprint()).toEqual(before);
  });

  it("preserves legacy same-case duplicate rows and selects their lowest adjustment ID", async () => {
    const { caseA, visitId, adjustmentId } = await historicalVisit();
    const duplicateId = await legacyAdjustment(caseA, visitId);
    expect(duplicateId).toBeGreaterThan(adjustmentId);
    await closeCase(caseA);
    const before = await footprint();
    expect(await db.getClinicalVisit(visitId)).toMatchObject({ ortho: { caseId: caseA, visitAdjustmentId: adjustmentId } });
    expect(await record(caseA, visitId)).toMatchObject({ ok: true, created: false, id: adjustmentId });
    expect(await footprint()).toEqual(before);
    const moneyBefore = await snapshot(financeTables);
    expect(await sign(visitId)).toMatchObject({ reason: null, invoiceId: null,
      visit: { ortho: { caseId: caseA, visitAdjustmentId: adjustmentId } } });
    expect(await q("SELECT id FROM ortho_adjustments WHERE visit_id=$1 ORDER BY id", [visitId]))
      .toEqual([{ id: adjustmentId }, { id: duplicateId }]);
    expect(await snapshot(financeTables)).toEqual(moneyBefore);
  });

  it.each(["foreign", "null-patient", "multiple-case"] as const)("rejects %s legacy adjustment scope explicitly with no read/sign side effects", async kind => {
    const owner = await patient();
    const caseA = await openCase(owner.id);
    const visitOwner = kind === "foreign" ? (await patient()).id : kind === "null-patient" ? null : owner.id;
    const visitId = await visit(visitOwner, true);
    if (kind === "multiple-case") {
      await adjustment(caseA, visitId);
      await closeCase(caseA);
      await legacyAdjustment(await openCase(owner.id), visitId);
    } else {
      await legacyAdjustment(caseA, visitId);
    }
    const before = await footprint();
    await expect(db.getClinicalVisit(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await footprint()).toEqual(before);
    await expect(db.previewVisitBilling(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await footprint()).toEqual(before);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await footprint()).toEqual(before);
  });

  it.each([false, true])("refuses a keyed replay of ambiguous history, signed=%s, without writes", async signed => {
    const owner = await patient();
    const caseA = await openCase(owner.id);
    const visitId = await visit(owner.id);
    const input = { ...session(caseA), visitId, doneOn: DAY, recordedBy: ACTOR, actorRole: "doctor",
      request: { key: `history-keyed-conflict-${++sequence}`, patientId: owner.id, session: actorSession } };
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: true });
    if (signed) expect(await sign(visitId)).toMatchObject({ reason: null });
    await closeCase(caseA);
    await legacyAdjustment(await openCase(owner.id, true), visitId);
    const before = await footprint();
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: false, status: 409,
      code: "ortho_visit_scope_conflict" });
    expect(await footprint()).toEqual(before);
  });

  it("preserves the exact keyed receipt through same-case duplicates and signed closure", async () => {
    const owner = await patient();
    const caseA = await openCase(owner.id);
    const visitId = await visit(owner.id);
    const input = { ...session(caseA), visitId, doneOn: DAY, recordedBy: ACTOR, actorRole: "doctor",
      request: { key: `history-keyed-duplicates-${++sequence}`, patientId: owner.id, session: actorSession } };
    // Reserve an older synthetic import ID. The receipt must keep its exact
    // adjustment, even when the historical read projection uses an earlier ID.
    const [{ id: olderId }] = await q<{ id: number }>(
      "SELECT nextval(pg_get_serial_sequence('ortho_adjustments','id'))::int AS id");
    const first = await db.recordAdjustment(input);
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) throw new Error(first.message);
    expect(first.id).toBeGreaterThan(olderId);
    await q(`INSERT INTO ortho_adjustments (id,case_id,visit_id,done_on,done,recorded_by)
      VALUES ($1,$2,$3,$4::date,'Synthetic same-case legacy import',$5)`, [olderId, caseA, visitId, DAY, ACTOR]);
    expect(await sign(visitId)).toMatchObject({ reason: null });
    await closeCase(caseA);
    const before = await footprint();
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false, replayed: true,
      id: first.id, visitId, attachedToToday: false });
    expect(await footprint()).toEqual(before);
  });

  it("refuses attaching B to an unsigned visit that already records A, without any writes", async () => {
    const { owner, caseA, visitId, adjustmentId } = await historicalVisit();
    await closeCase(caseA);
    const caseB = await openCase(owner.id, true);
    const before = await footprint();
    expect(await record(caseB, visitId)).toMatchObject({ ok: false, status: 409,
      code: "ortho_visit_scope_conflict" });
    expect(await footprint()).toEqual(before);
    expect(await db.getClinicalVisit(visitId)).toMatchObject({ ortho: { caseId: caseA, visitAdjustmentId: adjustmentId } });
  });

  it("refuses signing with input B when the visit already records A, without any writes", async () => {
    const { owner, caseA, visitId } = await historicalVisit();
    await closeCase(caseA);
    const caseB = await openCase(owner.id, true);
    const before = await footprint();
    expect(await sign(visitId, { orthoSession: session(caseB) })).toMatchObject({ reason: "ortho_case_invalid", invoiceId: null });
    expect(await footprint()).toEqual(before);
  });

  it("revalidates recorded case scope after acquiring the visit lock, before signature side effects", async () => {
    const { owner, caseA, visitId } = await historicalVisit();
    // Ordinary documentation lets the unfixed baseline reach the transaction even
    // though its wrong open-case projection loses A's adjustment in the first read.
    expect(await db.saveClinicalNotes({ visitId, chiefComplaint: null, examination: null,
      diagnosis: "Synthetic race documentation", treatmentDone: null, nextPlan: null, doctorId })).toBe(true);
    await closeCase(caseA);
    const caseB = await openCase(owner.id, true);
    const holder = await db.getPool().connect();
    let signing: ReturnType<typeof sign> | undefined;
    let holding = false;
    try {
      await holder.query("BEGIN");
      holding = true;
      await holder.query("SET LOCAL lock_timeout = '8s'");
      await holder.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [visitId]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      signing = sign(visitId);
      // The pending assertion is attached immediately, including in a negative control.
      void signing.catch(() => undefined);
      expect(await waitForVisitLock(holder, holderPid)).not.toBe(holderPid);
      await legacyAdjustment(caseB, visitId, holder);
      // This connection sees its injected row while the signer is still blocked.
      const injected = await footprint(holder);
      await holder.query("COMMIT");
      holding = false;
      await expect(signing).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
      expect(await footprint()).toEqual(injected);
    } finally {
      if (holding) await holder.query("ROLLBACK");
      holder.release();
      if (signing) await Promise.allSettled([signing]);
    }
  }, 25_000);
});
