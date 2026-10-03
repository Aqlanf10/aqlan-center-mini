import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import type { VisitProcedureInput } from "../../lib/clinical";
import type { ProcedurePriceOverride, QueryResult } from "../../lib/db";

const routeSession = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: routeSession.requireSession }));

// This suite deliberately resets only the guarded, isolated PostgreSQL 18 test DB.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { GET, POST } = await import("../../app/api/visits/[id]/clinical/route");
type SaveInput = Parameters<typeof db.saveClinicalDraft>[0];
type RawDraft = { visit: Record<string, unknown>; procedures: Record<string, unknown>[]; audits: Record<string, unknown>[] };
let patientId = 0;
let otherPatientId = 0;
let doctorA = 0;
let doctorB = 0;
let priced = 0;
let unpriced = 0;
let visitId = 0;
let sequence = 0;
const actor = { username: "atomic-doctor", role: "doctor" as const };
const notes = { chiefComplaint: "new chief", examination: "new examination", diagnosis: "new diagnosis",
  treatmentDone: "new treatment", nextPlan: "new next plan" };
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
const line = (serviceId = priced, unitPriceMinor = 15000): VisitProcedureInput => ({
  serviceId, unitPriceMinor, doctorId: doctorB, toothCode: 17, surfaces: null, quantity: 1,
  note: "new procedure note", planItemId: null, priceReason: null,
});
const input = (change: Partial<SaveInput> = {}): SaveInput => ({
  visitId, ...notes, doctorId: doctorB, authorizedPatientId: patientId, actor,
  billingCurrency: "YER", maxDiscountPercent: 10, procedures: [line()], ...change,
});
async function rawDraft(executor: {
  query(sql: string, values?: unknown[]): Promise<{ rows: { snapshot: RawDraft }[] }>;
} = db.getPool()): Promise<RawDraft> {
  const { rows: [row] } = await executor.query(
    `SELECT jsonb_build_object(
       'visit', to_jsonb(v),
       'procedures', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
                        FROM visit_procedures p WHERE p.visit_id = v.id),
       'audits', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
                   FROM audit_log a WHERE a.entity = 'visit' AND a.entity_id = v.id::text)
     ) AS snapshot FROM visits v WHERE v.id = $1`, [visitId]);
  return row.snapshot;
}

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  doctorA = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Atomic doctor A') RETURNING id`))[0].id;
  doctorB = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Atomic doctor B') RETURNING id`))[0].id;
  priced = (await q<{ id: number }>(`INSERT INTO services (name, category, price_minor, price_usd_minor, price_sar_minor, price_configured, is_active)
    VALUES ('Atomic priced', 'cleaning', 15000, 12000, 11000, TRUE, TRUE) RETURNING id`))[0].id;
  unpriced = (await q<{ id: number }>(`INSERT INTO services (name, category, price_minor, price_configured, is_active)
    VALUES ('Atomic manual price', 'cleaning', 0, FALSE, TRUE) RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });
beforeEach(async () => {
  routeSession.requireSession.mockResolvedValue({ role: "admin", username: "atomic-admin" });
  // Separate patients prevent earlier active plans affecting later sign controls.
  patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Atomic patient') RETURNING id`, [`ATOMIC-MAIN-${++sequence}`]))[0].id;
  otherPatientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Other atomic patient') RETURNING id`, [`ATOMIC-OTHER-${sequence}`]))[0].id;
  visitId = (await q<{ id: number }>(`INSERT INTO visits (patient_id, patient_name, doctor_id, status, billing_currency,
      chief_complaint, examination, diagnosis, treatment_done, next_plan, arrived_at)
    VALUES ($1, 'Atomic patient', $2, 'seated', 'USD', 'old chief', 'old examination', 'old diagnosis', 'old treatment', 'old next plan', NOW())
    RETURNING id`, [patientId, doctorA]))[0].id;
  await q(`INSERT INTO visit_procedures (visit_id, service_id, doctor_id, tooth_code, surfaces, quantity, unit_price_minor, note)
    VALUES ($1, $2, $3, 16, 'MO', 1, 12000, 'original line')`, [visitId, priced, doctorA]);
});

async function plan(options: { patient?: number; count?: number; funded?: boolean; ordered?: boolean } = {}) {
  const count = options.count ?? 2;
  const created = await db.createPlanV2({
    patientId: options.patient ?? patientId, title: `Atomic plan ${++sequence}`, specialty: null,
    primaryDoctorId: doctorA, billingMode: options.funded ? "installments" : "per_procedure",
    baseCurrency: "YER", startDate: "2026-01-01", note: null, createdBy: actor.username,
    items: [{ serviceId: priced, serviceName: "Atomic priced", category: "cleaning", toothCode: 17, surfaces: null,
      quantity: 1, unitPriceMinor: 30000, billingRule: "per_session", sessionCount: count, note: null,
      ...(options.ordered ? { sessionPlan: Array.from({ length: count }, (_, index) => ({
        title: `Session ${index + 1}`, minutes: 30, visitKey: `atomic:${index}`, visitTitle: `Visit ${index + 1}`,
      })) } : {}),
    }],
    installments: options.funded ? [{ dueDate: "2026-01-01", amountMinor: 30000 }] : [],
  });
  if (!created.ok) throw new Error(created.message);
  const consent = await db.recordPlanConsent({ planId: created.planId, actor: actor.username, note: null });
  if (!consent.ok) throw new Error(consent.message);
  const [item] = await q<{ id: number }>("SELECT id FROM plan_items WHERE plan_id = $1", [created.planId]);
  const planned = await q<{ id: number }>("SELECT id FROM planned_visits WHERE plan_id = $1 ORDER BY sequence", [created.planId]);
  return { id: created.planId, itemId: item.id, planned };
}

// NEW AUTHORED UNRUN source: reuse this suite's already-established A/B patients,
// admin route session and isolated DB ownership. No patient creation API, auth
// changes, new schema/triggers, signing, or unlinked visit is part of these cases.
describe("already-linked clinical draft intent before fresh route preflight", () => {
  const context = () => ({ params: Promise.resolve({ id: String(visitId) }) });
  const request = (body: Record<string, unknown>) => new Request(`http://localhost/api/visits/${visitId}/clinical`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  async function readThenCorrectEmptyLinkedVisit() {
    // The ordinary beforeEach visit has saved notes/procedures and must not be
    // force-relinked. Use another genuinely empty, already-linked visit instead.
    visitId = (await q<{ id: number }>(`INSERT INTO visits (patient_id, patient_name, doctor_id, status, billing_currency)
      VALUES ($1, 'Atomic patient', $2, 'waiting', 'USD') RETURNING id`, [patientId, doctorA]))[0].id;
    const initial = await GET(new Request(`http://localhost/api/visits/${visitId}/clinical`), context());
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ id: visitId, patientId, procedures: [] });
    expect(await db.linkVisitToPatient(visitId, otherPatientId)).toMatchObject({ ok: true });
    const before = await rawDraft();
    expect(before.visit.patient_id).toBe(otherPatientId);
    expect(before.visit.diagnosis).toBeNull();
    expect(before.procedures).toEqual([]);
    return before;
  }

  it("denies retained A intent after a legitimate empty A-to-B correction without changing any saved data", async () => {
    const before = await readThenCorrectEmptyLinkedVisit();
    const response = await POST(request({ ...notes, doctorId: doctorB, billingCurrency: "YER", procedures: [line()],
      expectedLinkedPatientId: patientId }), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "visit_patient_changed" });
    expect(await rawDraft()).toEqual(before);
  });

  it("accepts the current linked B expectation using ordinary server authorization", async () => {
    await readThenCorrectEmptyLinkedVisit();
    const response = await POST(request({ ...notes, doctorId: doctorB, billingCurrency: "YER", procedures: [line()],
      expectedLinkedPatientId: otherPatientId, patientId, authorizedPatientId: patientId }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ patientId: otherPatientId, ...notes });
    const after = await rawDraft();
    expect(after.visit).toMatchObject({ patient_id: otherPatientId, diagnosis: notes.diagnosis, doctor_id: doctorB, billing_currency: "YER" });
    expect(after.procedures).toHaveLength(1);
  });

  it("explicitly preserves omitted-field legacy behavior as partial intent protection", async () => {
    await readThenCorrectEmptyLinkedVisit();
    const response = await POST(request({ ...notes, doctorId: doctorB }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ patientId: otherPatientId, diagnosis: notes.diagnosis });
    expect((await rawDraft()).visit.patient_id).toBe(otherPatientId);
  });
});

describe("clinical draft save is a single real transaction", () => {
  it("actual route rejects invalid currency before mutating the real database", async () => {
    const before = await rawDraft();
    const response = await POST(new Request(`http://localhost/api/visits/${visitId}/clinical`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...notes, doctorId: doctorB, billingCurrency: "JPY", procedures: [line()] }),
    }), { params: Promise.resolve({ id: String(visitId) }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: "عملة الزيارة غير صالحة." });
    expect(await rawDraft()).toEqual(before);
  });

  it("commits all five notes, provider, currency, lines and an override audit together", async () => {
    const before = await rawDraft();
    expect(await db.saveClinicalDraft(input({ procedures: [line(unpriced, 7000), line()] }))).toBe(true);
    const after = await rawDraft();
    expect(after.visit).toEqual({ ...before.visit, chief_complaint: notes.chiefComplaint, examination: notes.examination,
      diagnosis: notes.diagnosis, treatment_done: notes.treatmentDone, next_plan: notes.nextPlan,
      doctor_id: doctorB, billing_currency: "YER" });
    expect(after.procedures.map((row) => [row.service_id, row.doctor_id, row.unit_price_minor])).toEqual([
      [unpriced, doctorB, 7000], [priced, doctorB, 15000],
    ]);
    expect(after.procedures.every((row) => !before.procedures.some((old) => old.id === row.id))).toBe(true);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ action: "visit.price_override", actor: actor.username, actor_role: "doctor",
      details: { الخدمة: "Atomic manual price", العملة: "YER", النوع: "سعر يدوي لخدمة غير مسعّرة",
        سعر_الدليل: 0, السعر_المعتمد: 7000, نسبة_الخصم: null, السبب: null } });
  });

  it("rolls back a later price failure including earlier accepted override and currency", async () => {
    const before = await rawDraft();
    await expect(db.saveClinicalDraft(input({ procedures: [line(unpriced, 7000), { ...line(priced, 20000), priceReason: "Synthetic increase" }] })))
      .rejects.toBeInstanceOf(db.ProcedurePriceRejected);
    expect(await rawDraft()).toEqual(before);
  });

  it.each(["service", "tooth", "owner", "missing", "exhausted", "order"] as const)("rolls back a %s plan conflict", async (conflict) => {
    const p = await plan({ patient: conflict === "owner" ? otherPatientId : patientId, count: 2, ordered: conflict === "order" });
    if (conflict === "exhausted") await q("UPDATE treatment_sessions SET status = 'done' WHERE plan_item_id = $1", [p.itemId]);
    if (conflict === "order") await q("UPDATE visits SET planned_visit_id = $2 WHERE id = $1", [visitId, p.planned[1].id]);
    const linked = { ...line(conflict === "service" ? unpriced : priced, 1),
      toothCode: conflict === "tooth" ? 18 : 17, planItemId: conflict === "missing" ? 2147483647 : p.itemId };
    const before = await rawDraft();
    await expect(db.saveClinicalDraft(input({ procedures: [line(unpriced, 7000), linked] }))).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await rawDraft()).toEqual(before);
  });

  it.each([false, true])("keeps canonical plan pricing and agreement inclusion (funded=%s)", async (funded) => {
    const p = await plan({ funded });
    expect(await db.saveClinicalDraft(input({ procedures: [{ ...line(priced, 999999), quantity: 5, planItemId: p.itemId }] }))).toBe(true);
    expect((await rawDraft()).procedures).toEqual([expect.objectContaining({ quantity: 1, unit_price_minor: funded ? 0 : 15000, plan_item_id: p.itemId })]);
  });

  it("rolls back notes, lines, currency and the first audit when the second audit INSERT throws", async () => {
    const before = await rawDraft();
    // Synthetic fixture-only trigger; no production code failure hooks or migrations.
    await q(`CREATE FUNCTION reject_atomic_draft_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'visit.price_override' AND NEW.entity_id = TG_ARGV[0]
           AND NEW.details ->> 'السعر_المعتمد' = '8000' THEN RAISE EXCEPTION 'synthetic atomic audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await q(`CREATE TRIGGER reject_atomic_draft_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_atomic_draft_audit('${visitId}')`);
    try {
      await expect(db.saveClinicalDraft(input({ procedures: [line(unpriced, 7000), line(unpriced, 8000)] })))
        .rejects.toThrow("synthetic atomic audit failure");
      expect(await rawDraft()).toEqual(before);
    } finally {
      await q("DROP TRIGGER reject_atomic_draft_audit ON audit_log");
      await q("DROP FUNCTION reject_atomic_draft_audit()");
    }
  });

  it("keeps notes-only procedures/currency and null-doctor COALESCE compatibility", async () => {
    const before = await rawDraft();
    expect(await db.saveClinicalDraft(input({ doctorId: null, procedures: undefined }))).toBe(true);
    const after = await rawDraft();
    expect(after.visit).toEqual({ ...before.visit, chief_complaint: notes.chiefComplaint, examination: notes.examination,
      diagnosis: notes.diagnosis, treatment_done: notes.treatmentDone, next_plan: notes.nextPlan });
    expect(after.procedures).toEqual(before.procedures);
    expect(after.audits).toEqual(before.audits);
  });

  it("treats [] as explicit clearing while omitted currency stays USD", async () => {
    expect(await db.saveClinicalDraft(input({ procedures: [], billingCurrency: undefined }))).toBe(true);
    const saved = await rawDraft();
    expect(saved.procedures).toEqual([]);
    expect(saved.visit.billing_currency).toBe("USD");
  });

  it("leaves signed or missing visits untouched", async () => {
    await q("UPDATE visits SET signed_at = NOW(), signed_by = 'synthetic' WHERE id = $1", [visitId]);
    const before = await rawDraft();
    expect(await db.saveClinicalDraft(input())).toBe(false);
    expect(await rawDraft()).toEqual(before);
    expect(await db.saveClinicalDraft(input({ visitId: 2147483647 }))).toBe(false);
  });

  it("retains both exported compatibility wrappers and only exposes committed overrides", async () => {
    const overrides: ProcedurePriceOverride[] = [];
    const before = await rawDraft();
    await expect(db.setVisitProcedures({ visitId, procedures: [line(unpriced, 7000), line(priced, 20000)],
      authority: { role: "doctor", maxDiscountPercent: 10 }, billingCurrency: "YER", overrides })).rejects.toBeInstanceOf(db.ProcedurePriceRejected);
    expect(await rawDraft()).toEqual(before);
    expect(overrides).toEqual([]);
    expect(await db.saveClinicalNotes({ visitId, ...notes, doctorId: null })).toBe(true);
    expect((await rawDraft()).visit.doctor_id).toBe(doctorA);
    expect(await db.setVisitProcedures({ visitId, procedures: [line(unpriced, 7000)],
      authority: { role: "doctor", maxDiscountPercent: 10 }, billingCurrency: "YER", overrides })).toBe(true);
    expect(overrides).toHaveLength(1);
  });
});

const assistantInput = (change: Partial<SaveInput> = {}): SaveInput => input({
  actor: { username: "atomic-assistant", role: "assistant" }, doctorId: doctorA,
  procedures: undefined, ...change,
});
async function savedLines(): Promise<VisitProcedureInput[]> {
  return (await q<{ service_id: number; doctor_id: number | null; tooth_code: number | null; surfaces: string | null;
    quantity: number; unit_price_minor: string; note: string | null; plan_item_id: number | null }>(
    "SELECT * FROM visit_procedures WHERE visit_id = $1 ORDER BY id", [visitId])).map((p) => ({
    serviceId: p.service_id, doctorId: p.doctor_id, toothCode: p.tooth_code, surfaces: p.surfaces,
    quantity: p.quantity, unitPriceMinor: Number(p.unit_price_minor), note: p.note, planItemId: p.plan_item_id,
  }));
}
describe("locked clinical authority", () => {
  it("assistant changes only notes even when unchanged procedures and currency are supplied", async () => {
    const before = await rawDraft();
    // A column-specific trigger proves doctor_id is absent from the assistant UPDATE,
    // rather than merely assigned its previous value. Synthetic isolated fixture only.
    await q(`CREATE FUNCTION reject_atomic_assistant_provider() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id::text = TG_ARGV[0] THEN RAISE EXCEPTION 'assistant attempted provider assignment'; END IF;
        RETURN NEW;
      END $$`);
    await q(`CREATE TRIGGER reject_atomic_assistant_provider BEFORE UPDATE OF doctor_id ON visits
      FOR EACH ROW EXECUTE FUNCTION reject_atomic_assistant_provider('${visitId}')`);
    try {
      expect(await db.saveClinicalDraft(assistantInput({ assistantProcedures: await savedLines() }))).toBe(true);
    } finally {
      await q("DROP TRIGGER reject_atomic_assistant_provider ON visits");
      await q("DROP FUNCTION reject_atomic_assistant_provider()");
    }
    const after = await rawDraft();
    expect(after.visit).toEqual({ ...before.visit, chief_complaint: notes.chiefComplaint, examination: notes.examination,
      diagnosis: notes.diagnosis, treatment_done: notes.treatmentDone, next_plan: notes.nextPlan });
    expect(after.procedures).toEqual(before.procedures);
    expect(after.audits).toEqual(before.audits);
  });

  it.each(["provider", "procedures", "old day", "patient"] as const)("rejects a locked %s authority mismatch with no mutation", async (kind) => {
    const request = assistantInput({ assistantProcedures: await savedLines() });
    if (kind === "provider") await q("UPDATE visits SET doctor_id = $2 WHERE id = $1", [visitId, doctorB]);
    if (kind === "procedures") await q("UPDATE visit_procedures SET unit_price_minor = unit_price_minor + 1 WHERE visit_id = $1", [visitId]);
    if (kind === "old day") await q("UPDATE visits SET arrived_at = NOW() - INTERVAL '2 days' WHERE id = $1", [visitId]);
    if (kind === "patient") await q("UPDATE visits SET patient_id = $2 WHERE id = $1", [visitId, otherPatientId]);
    const before = await rawDraft();
    await expect(db.saveClinicalDraft(request)).rejects.toBeInstanceOf(db.ClinicalDraftAccessRejected);
    expect(await rawDraft()).toEqual(before);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function pauseNextTransaction(afterSql: RegExp) {
  const paused = deferred();
  const release = deferred();
  let pid = 0;
  let stopped = false;
  const pool = db.getPool();
  const connect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect").mockImplementation(async (...args: unknown[]) => {
    // pg.Pool.query uses callback-style connect internally. Preserve that path;
    // only the application's explicit promise-style transaction is instrumented.
    if (args.length > 0) return Reflect.apply(connect, pool, args);
    const client = await connect();
    pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const query = client.query.bind(client);
    return {
      async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
        const result = await query<T>(sql, values);
        if (!stopped && afterSql.test(sql)) { stopped = true; paused.resolve(); await release.promise; }
        return result;
      },
      release: () => client.release(),
    };
  });
  return { paused, release, spy, pid: () => pid };
}
async function waitForBlocked(observer: Client, blockingPid: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked`, [blockingPid]);
    if (rows[0].blocked) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error("Expected a real PostgreSQL row-lock wait");
}
const sign = () => db.signClinicalVisit({ visitId, signedBy: "atomic-signer", baseCurrency: "YER", signerDoctorPartyId: doctorA });

describe("clinical visit-first lock serialization", () => {
  it("sign waits for a complete save and signs its notes and procedures together", async () => {
    const gate = pauseNextTransaction(/UPDATE visits SET chief_complaint/);
    const saving = db.saveClinicalDraft(input());
    const observer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    let signing: ReturnType<typeof sign> | undefined;
    try {
      await Promise.race([gate.paused.promise, saving.then(() => { throw new Error("Save ended before barrier"); })]);
      gate.spy.mockRestore();
      await observer.connect();
      signing = sign();
      await waitForBlocked(observer, gate.pid());
      gate.release.resolve();
      expect(await saving).toBe(true);
      const result = await signing;
      expect(result.reason).toBeNull();
      expect(result.duesMinor).toBe(15000);
      const saved = await rawDraft();
      expect(saved.visit).toMatchObject({ chief_complaint: notes.chiefComplaint, examination: notes.examination,
        diagnosis: notes.diagnosis, treatment_done: notes.treatmentDone, next_plan: notes.nextPlan,
        doctor_id: doctorB, billing_currency: "YER", signed_by: "atomic-signer" });
      expect(saved.procedures).toEqual([expect.objectContaining({ unit_price_minor: 15000, doctor_id: doctorB, tooth_code: 17 })]);
      expect(await q("SELECT doctor_id, unit_price_minor FROM invoice_items WHERE invoice_id = $1", [result.invoiceId]))
        .toEqual([expect.objectContaining({ doctor_id: doctorB, unit_price_minor: "15000" })]);
    } finally {
      gate.release.resolve(); gate.spy.mockRestore();
      await saving.catch(() => {}); await signing?.catch(() => {}); await observer.end().catch(() => {});
    }
  });

  it("save waits behind a completed signature and cannot alter the signed snapshot", async () => {
    const gate = pauseNextTransaction(/UPDATE visits SET signed_at/);
    const signing = sign();
    const observer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    let saving: ReturnType<typeof db.saveClinicalDraft> | undefined;
    try {
      await Promise.race([gate.paused.promise, signing.then(() => { throw new Error("Sign ended before barrier"); })]);
      gate.spy.mockRestore();
      await observer.connect();
      const before = await rawDraft();
      saving = db.saveClinicalDraft(input());
      await waitForBlocked(observer, gate.pid());
      gate.release.resolve();
      expect((await signing).reason).toBeNull();
      expect(await saving).toBe(false);
      const after = await rawDraft();
      for (const field of ["chief_complaint", "examination", "diagnosis", "treatment_done", "next_plan", "doctor_id", "billing_currency"]) {
        expect(after.visit[field]).toEqual(before.visit[field]);
      }
      expect(after.procedures).toEqual(before.procedures);
      expect(after.audits).toEqual(before.audits);
    } finally {
      gate.release.resolve(); gate.spy.mockRestore();
      await signing.catch(() => {}); await saving?.catch(() => {}); await observer.end().catch(() => {});
    }
  });

  it("serializes two tokenless complete saves without mixing headers and lines", async () => {
    const gate = pauseNextTransaction(/UPDATE visits SET chief_complaint/);
    const first = db.saveClinicalDraft(input());
    const observer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    let second: ReturnType<typeof db.saveClinicalDraft> | undefined;
    try {
      await Promise.race([gate.paused.promise, first.then(() => { throw new Error("Save ended before barrier"); })]);
      gate.spy.mockRestore();
      await observer.connect();
      second = db.saveClinicalDraft(input({ chiefComplaint: "second chief", examination: "second examination", diagnosis: "second diagnosis",
        treatmentDone: "second treatment", nextPlan: "second plan", doctorId: doctorA, billingCurrency: "SAR",
        procedures: [{ ...line(priced, 11000), doctorId: doctorA, toothCode: 18 }] }));
      await waitForBlocked(observer, gate.pid());
      gate.release.resolve();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      const saved = await rawDraft();
      expect(saved.visit).toMatchObject({ chief_complaint: "second chief", examination: "second examination", diagnosis: "second diagnosis",
        treatment_done: "second treatment", next_plan: "second plan", doctor_id: doctorA, billing_currency: "SAR" });
      expect(saved.procedures).toEqual([expect.objectContaining({ unit_price_minor: 11000, doctor_id: doctorA, tooth_code: 18 })]);
    } finally {
      gate.release.resolve(); gate.spy.mockRestore();
      await first.catch(() => {}); await second?.catch(() => {}); await observer.end().catch(() => {});
    }
  });

  it.each(["provider", "procedures", "old day", "patient"] as const)("rechecks assistant %s after a competing locked writer commits", async (kind) => {
    const request = assistantInput({ assistantProcedures: await savedLines() });
    const writer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    const observer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    let saving: Promise<unknown> | undefined;
    try {
      await writer.connect(); await observer.connect();
      await writer.query("BEGIN");
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await writer.query("SELECT id FROM visits WHERE id = $1 FOR UPDATE", [visitId]);
      if (kind === "provider") await writer.query("UPDATE visits SET doctor_id = $2 WHERE id = $1", [visitId, doctorB]);
      if (kind === "procedures") await writer.query("UPDATE visit_procedures SET unit_price_minor = unit_price_minor + 1 WHERE visit_id = $1", [visitId]);
      if (kind === "old day") await writer.query("UPDATE visits SET arrived_at = NOW() - INTERVAL '2 days' WHERE id = $1", [visitId]);
      if (kind === "patient") await writer.query("UPDATE visits SET patient_id = $2 WHERE id = $1", [visitId, otherPatientId]);
      saving = db.saveClinicalDraft(request).catch((error: unknown) => error);
      await waitForBlocked(observer, pid);
      // Capture the winner through its own transaction while save is still blocked.
      // A rejected save must not be able to contaminate the expected snapshot.
      const winner = await rawDraft(writer);
      await writer.query("COMMIT");
      expect(await saving).toBeInstanceOf(db.ClinicalDraftAccessRejected);
      expect(await rawDraft()).toEqual(winner);
    } finally {
      await writer.query("ROLLBACK").catch(() => {}); await saving?.catch(() => {});
      await writer.end().catch(() => {}); await observer.end().catch(() => {});
    }
  });
});
