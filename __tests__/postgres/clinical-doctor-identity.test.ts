import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClinicalDoctorIdentityConflict } from "../../lib/clinical-doctor-identity";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

// Synthetic fixtures only, through the existing isolated PostgreSQL 18 CI
// harness. Validate the original environment before stubPostgresEnv clears it.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
type Procedure = Parameters<typeof db.setVisitProcedures>[0]["procedures"][number];
type Notes = Omit<Parameters<typeof db.saveClinicalNotes>[0], "visitId">;
type BillingRule = "on_start" | "on_completion" | "per_session";
let sequence = 0;
let doctorA: number;
let doctorB: number;
let supplierId: number;
let labId: number;
let crownServiceId: number;
let materialId: number;

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query(sql, values)).rows as T[];
}

async function party(kind: "doctor" | "supplier" | "lab", active = true) {
  return (await q<{ id: number }>(
    `INSERT INTO parties (kind, name, is_active) VALUES ($1, $2, $3) RETURNING id`,
    [kind, `Synthetic identity ${kind} ${++sequence}`, active],
  ))[0].id;
}

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  doctorA = await party("doctor");
  doctorB = await party("doctor");
  supplierId = await party("supplier");
  labId = await party("lab");
  crownServiceId = (await q<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, is_active, price_configured)
     VALUES ('Synthetic identity crown', 'crown', 60000, TRUE, TRUE) RETURNING id`,
  ))[0].id;
  materialId = (await q<{ id: number }>(
    `INSERT INTO inventory_items (name, category, unit, min_level, created_by)
     VALUES ('Synthetic identity material', 'other', 'unit', 0, 'identity-test') RETURNING id`,
  ))[0].id;
  await q(`INSERT INTO inventory_movements (item_id, kind, qty, created_by)
    VALUES ($1, 'in', 1000, 'identity-test')`, [materialId]);
  await q(`INSERT INTO service_materials (service_id, item_id, qty_per_unit, created_by)
    VALUES ($1, $2, 1, 'identity-test')`, [crownServiceId, materialId]);
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function patient() {
  return (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`,
    [`DOCTOR-IDENTITY-${++sequence}`],
  ))[0].id;
}

function notes(label: string, doctorId: number | null = doctorA): Notes {
  return {
    chiefComplaint: `${label} complaint`, examination: `${label} examination`,
    diagnosis: `${label} diagnosis`, treatmentDone: `${label} treatment`,
    nextPlan: `${label} next plan`, doctorId,
  };
}

function procedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    serviceId: crownServiceId, toothCode: 21, surfaces: null, quantity: 1,
    unitPriceMinor: 60000, priceReason: "Synthetic identity test", doctorId: doctorB,
    note: "Synthetic saved procedure", planItemId: null, ...overrides,
  };
}

async function visit(patientId: number, lines: Procedure[], visitDoctorId: number | null = doctorA) {
  const result = await db.addVisit({
    patientId, patientName: "Synthetic identity patient", patientPhone: null, note: null,
  });
  expect(await db.setVisitProcedures({
    visitId: result.id, procedures: lines, clinicalNotes: notes("Original", visitDoctorId),
  })).toBe(true);
  return result.id;
}

const sign = (visitId: number, signerDoctorPartyId: number | null = doctorA) => db.signClinicalVisit({
  visitId, baseCurrency: "YER", signedBy: "identity-test-admin", signerRole: "admin", signerDoctorPartyId,
});

// Full existing rows, rather than only row counts: a refused sign must not
// advance or reprice anything, including records from an earlier valid session.
async function clinicalState(patientId: number) {
  const statements = {
    patients: `SELECT to_jsonb(p) AS row FROM patients p WHERE id = $1 ORDER BY id`,
    visits: `SELECT to_jsonb(v) AS row FROM visits v WHERE patient_id = $1 ORDER BY id`,
    procedures: `SELECT to_jsonb(p) AS row FROM visit_procedures p JOIN visits v ON v.id = p.visit_id WHERE v.patient_id = $1 ORDER BY p.id`,
    plans: `SELECT to_jsonb(t) AS row FROM treatment_plans t WHERE patient_id = $1 ORDER BY id`,
    items: `SELECT to_jsonb(i) AS row FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY i.id`,
    sessions: `SELECT to_jsonb(s) AS row FROM treatment_sessions s JOIN plan_items i ON i.id = s.plan_item_id JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY s.id`,
    plannedVisits: `SELECT to_jsonb(v) AS row FROM planned_visits v WHERE patient_id = $1 ORDER BY id`,
    appointments: `SELECT to_jsonb(a) AS row FROM appointments a WHERE patient_id = $1 ORDER BY id`,
    invoices: `SELECT to_jsonb(i) AS row FROM invoices i WHERE patient_id = $1 ORDER BY id`,
    invoiceItems: `SELECT to_jsonb(i) AS row FROM invoice_items i JOIN invoices inv ON inv.id = i.invoice_id WHERE inv.patient_id = $1 ORDER BY i.id`,
    chart: `SELECT to_jsonb(c) AS row FROM tooth_conditions c WHERE patient_id = $1 ORDER BY id`,
    lab: `SELECT to_jsonb(l) AS row FROM lab_orders l WHERE patient_id = $1 ORDER BY id`,
    inventory: `SELECT to_jsonb(m) AS row FROM inventory_movements m WHERE patient_id = $1 ORDER BY id`,
    payments: `SELECT to_jsonb(p) AS row FROM payments p WHERE patient_id = $1 ORDER BY id`,
    ortho: `SELECT to_jsonb(a) AS row FROM ortho_adjustments a JOIN visits v ON v.id = a.visit_id WHERE v.patient_id = $1 ORDER BY a.id`,
  };
  return Object.fromEntries(await Promise.all(Object.entries(statements).map(async ([name, sql]) =>
    [name, await q(sql, [patientId])],
  )));
}

async function plan(patientId: number, rule: BillingRule, included = false) {
  const result = await db.createPlanV2({
    patientId, title: "Synthetic identity plan", specialty: null, primaryDoctorId: doctorA,
    billingMode: included ? "installments" : "per_procedure", baseCurrency: "YER",
    startDate: "2026-01-01", note: null, createdBy: "identity-test",
    items: [{ serviceId: crownServiceId, serviceName: "Synthetic identity crown", category: "crown",
      toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 60000,
      billingRule: rule, sessionCount: 3, note: null }],
    installments: included ? [{ dueDate: "2026-01-01", amountMinor: 60000 }] : [],
  });
  if (!result.ok) throw new Error(result.message);
  expect((await db.recordPlanConsent({ planId: result.planId, actor: "identity-test", note: null })).ok).toBe(true);
  return (await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [result.planId]))[0].id;
}

describe("explicit clinical doctor identity on save", () => {
  it.each(["supplier", "lab"] as const)("rejects explicit %s without changing notes, currency, or any saved procedure", async (kind) => {
    const p = await patient(), v = await visit(p, [procedure()]);
    const before = await clinicalState(p);
    const attempt = db.setVisitProcedures({
      visitId: v, clinicalNotes: notes("Must roll back", doctorB), billingCurrency: "USD",
      procedures: [procedure({ doctorId: doctorA }), procedure({ doctorId: kind === "supplier" ? supplierId : labId, unitPriceMinor: 0 })],
    });
    await expect(attempt).rejects.toBeInstanceOf(ClinicalDoctorIdentityConflict);
    await expect(attempt).rejects.toMatchObject({ code: "invalid_procedure_doctor" });
    expect(await clinicalState(p)).toEqual(before);
  });

  it.each([0, -1, 1.25, 2_147_483_648, 2_000_000_000, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid/missing explicit identity %s with the domain conflict", async (doctorId) => {
      const p = await patient(), v = await visit(p, [procedure()]);
      const before = await clinicalState(p);
      await expect(db.setVisitProcedures({ visitId: v, procedures: [procedure({ doctorId })], clinicalNotes: notes("Rejected") }))
        .rejects.toBeInstanceOf(ClinicalDoctorIdentityConflict);
      expect(await clinicalState(p)).toEqual(before);
    },
  );

  it("rolls combined notes and procedure replacement back when a later plan check fails", async () => {
    const p = await patient(), v = await visit(p, [procedure()]);
    const before = await clinicalState(p);
    await expect(db.setVisitProcedures({
      visitId: v, clinicalNotes: notes("Rejected later", doctorB), billingCurrency: "USD",
      procedures: [procedure({ doctorId: doctorA, planItemId: 2_000_000_000 })],
    })).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await clinicalState(p)).toEqual(before);
  });
});

const paths = [
  { name: "stand-alone", rule: null, included: false },
  { name: "multi-session on-start", rule: "on_start", included: false },
  { name: "multi-session on-completion", rule: "on_completion", included: false },
  { name: "installment-included", rule: "per_session", included: true },
] as const;

describe.each(paths)("invalid unsigned draft: $name", ({ rule, included }) => {
  it.each([
    ["supplier", false], ["lab", false], ["supplier", true], ["lab", true],
  ] as const)("rejects %s (returning=%s) with every clinical and monetary row unchanged", async (kind, returning) => {
    const p = await patient();
    const itemId = rule ? await plan(p, rule, included) : null;
    if (returning) {
      const first = await visit(p, [procedure({ planItemId: itemId })]);
      expect((await sign(first)).reason).toBeNull();
    }
    const v = await visit(p, [procedure({ planItemId: itemId })]);
    // Deliberately bypass the new save guard to represent an unsigned draft
    // written by older code. This is synthetic SQL, not a supported endpoint.
    await q(`UPDATE visit_procedures SET doctor_id = $2 WHERE visit_id = $1`, [v, kind === "supplier" ? supplierId : labId]);
    const before = await clinicalState(p);
    await expect(sign(v, doctorB)).rejects.toBeInstanceOf(ClinicalDoctorIdentityConflict);
    expect(await clinicalState(p)).toEqual(before);
    expect(await q(`SELECT signed_at, signed_by, invoice_id FROM visits WHERE id = $1`, [v]))
      .toEqual([{ signed_at: null, signed_by: null, invoice_id: null }]);
    expect(await q(`SELECT (SELECT COUNT(*) FROM treatment_sessions WHERE visit_id = $1)::int AS sessions,
      (SELECT COUNT(*) FROM tooth_conditions WHERE visit_id = $1)::int AS chart,
      (SELECT COUNT(*) FROM lab_orders WHERE visit_id = $1)::int AS lab,
      (SELECT COUNT(*) FROM inventory_movements WHERE visit_id = $1)::int AS inventory`, [v]))
      .toEqual([{ sessions: 0, chart: 0, lab: 0, inventory: 0 }]);
  });
});

describe("valid explicit and nullable fallback attribution", () => {
  it.each([true, false])("preserves doctor B over visit A, including inactive B (active=%s)", async (active) => {
    const b = await party("doctor", active), p = await patient();
    const v = await visit(p, [procedure({ doctorId: b })]);
    const signed = await sign(v);
    expect(signed).toMatchObject({ reason: null, duesMinor: 60000, chartUpdates: 1, labOrdersCreated: 1, materialsDeducted: 1 });
    expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [v])).toEqual([{ doctor_id: b }]);
    expect(await q(`SELECT doctor_id, total_minor::text FROM invoice_items WHERE invoice_id = $1`, [signed.invoiceId]))
      .toEqual([{ doctor_id: b, total_minor: "60000" }]);
    expect(await q(`SELECT doctor_id FROM lab_orders WHERE visit_id = $1`, [v])).toEqual([{ doctor_id: b }]);
    expect(await q(`SELECT doctor_id, signed_by FROM visits WHERE id = $1`, [v]))
      .toEqual([{ doctor_id: doctorA, signed_by: "identity-test-admin" }]);
  });

  it.each(["visit", "signer", "invalid-visit"] as const)("resolves a NULL performer through the %s fallback", async (source) => {
    const p = await patient();
    const visitDoctor = source === "visit" ? doctorA : source === "invalid-visit" ? supplierId : null;
    const v = await visit(p, [procedure({ doctorId: null })], visitDoctor);
    expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [v])).toEqual([{ doctor_id: null }]);
    const signed = await sign(v, doctorB);
    expect(signed.reason).toBeNull();
    const expected = source === "visit" ? doctorA : doctorB;
    expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [v])).toEqual([{ doctor_id: expected }]);
    expect(await q(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [signed.invoiceId])).toEqual([{ doctor_id: expected }]);
    expect(await q(`SELECT doctor_id FROM lab_orders WHERE visit_id = $1`, [v])).toEqual([{ doctor_id: expected }]);
  });

  it("ignores invalid fallback parties: paid work still refuses, free work stays NULL", async () => {
    const paidPatient = await patient(), paid = await visit(paidPatient, [procedure({ doctorId: null })], supplierId);
    const before = await clinicalState(paidPatient);
    expect((await sign(paid, labId)).reason).toBe("no_treating_doctor");
    expect(await clinicalState(paidPatient)).toEqual(before);
    const free = await visit(await patient(), [procedure({ doctorId: null, unitPriceMinor: 0 })], supplierId);
    expect((await sign(free, labId)).reason).toBeNull();
    expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [free])).toEqual([{ doctor_id: null }]);
    expect(await q(`SELECT doctor_id FROM lab_orders WHERE visit_id = $1`, [free])).toEqual([{ doctor_id: null }]);
  });

  it("keeps an installment-included session NULL and unbilled without a valid fallback", async () => {
    const p = await patient(), itemId = await plan(p, "per_session", true);
    const v = await visit(p, [procedure({ doctorId: null, planItemId: itemId })], supplierId);
    const signed = await sign(v, labId);
    expect(signed).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0, sessionsCompleted: 1 });
    expect(await q(`SELECT doctor_id, unit_price_minor::text FROM visit_procedures WHERE visit_id = $1`, [v]))
      .toEqual([{ doctor_id: null, unit_price_minor: "0" }]);
    expect(await q(`SELECT doctor_id FROM lab_orders WHERE visit_id = $1`, [v])).toEqual([{ doctor_id: null }]);
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [p])).toEqual([]);
    expect(await q(`SELECT billing_status FROM plan_items WHERE id = $1`, [itemId]))
      .toEqual([{ billing_status: "included_in_package" }]);
  });

  it("leaves already-signed synthetic non-doctor history unchanged", async () => {
    const p = await patient(), v = await visit(p, [procedure()]);
    expect((await sign(v)).reason).toBeNull();
    // Synthetic historical corruption only: do not backfill or repair any
    // financial document. A repeat sign must leave the entire history alone.
    await q(`UPDATE visit_procedures SET doctor_id = $2 WHERE visit_id = $1`, [v, supplierId]);
    const before = await clinicalState(p);
    expect((await sign(v, doctorB)).reason).toBe("already_signed");
    expect(await clinicalState(p)).toEqual(before);
  });
});

describe.each([
  { rule: "on_start", included: false, expected: [60000, 0, 0] },
  { rule: "on_completion", included: false, expected: [0, 0, 60000] },
  { rule: "per_session", included: false, expected: [20000, 20000, 20000] },
  { rule: "per_session", included: true, expected: [0, 0, 0] },
] as const)("money rules preserved: $rule, included=$included", ({ rule, included, expected }) => {
  it("advances first and returning sessions once, preserving B attribution and exact total", async () => {
    const p = await patient(), itemId = await plan(p, rule, included);
    for (const [index, duesMinor] of expected.entries()) {
      const v = await visit(p, [procedure({ planItemId: itemId, unitPriceMinor: 999999 })]);
      expect(await q(`SELECT unit_price_minor::text FROM visit_procedures WHERE visit_id = $1`, [v]))
        .toEqual([{ unit_price_minor: String(duesMinor) }]);
      const signed = await sign(v);
      expect(signed).toMatchObject({ reason: null, duesMinor, sessionsCompleted: 1, materialsDeducted: 1, labOrdersCreated: index === 0 ? 1 : 0 });
      expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [v])).toEqual([{ doctor_id: doctorB }]);
      if (included) expect(signed.invoiceId).toBeNull();
      else expect(await q(`SELECT doctor_id, total_minor::text FROM invoice_items WHERE invoice_id = $1`, [signed.invoiceId]))
        .toEqual([{ doctor_id: doctorB, total_minor: String(duesMinor) }]);
      expect((await sign(v)).reason).toBe("already_signed");
    }
    expect(await q(`SELECT COALESCE(SUM(total_minor), 0)::text AS total FROM invoices WHERE patient_id = $1`, [p]))
      .toEqual([{ total: included ? "0" : "60000" }]);
    expect(await q(`SELECT status FROM plan_items WHERE id = $1`, [itemId])).toEqual([{ status: "done" }]);
    expect(await q(`SELECT COUNT(*)::int AS count FROM treatment_sessions WHERE plan_item_id = $1 AND status = 'done'`, [itemId]))
      .toEqual([{ count: 3 }]);
    expect(await q(`SELECT doctor_id FROM lab_orders WHERE patient_id = $1`, [p])).toEqual([{ doctor_id: doctorB }]);
    if (included) expect(await q(`SELECT billing_status FROM plan_items WHERE id = $1`, [itemId]))
      .toEqual([{ billing_status: "included_in_package" }]);
  });
});

// These are defensive direct-SQL races. updateParty does not expose kind
// changes, so they do not claim a normal endpoint can perform this mutation.
async function rawClient() {
  const client = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await client.connect();
  await client.query(`SET statement_timeout = '25s'`);
  return client;
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  ).finally(() => { settled = true; });
  return { result, settled: () => settled };
}

async function blockedPid(witness: Client, blocker: number, queryPattern: string, settled: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!settled() && Date.now() < deadline) {
    const { rows } = await witness.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
         AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))
         AND query ~* $2 ORDER BY pid`, [blocker, queryPattern],
    );
    if (rows[0]) return rows[0].pid;
    // Yield to the driver; elapsed time is never accepted as proof of a lock.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`No PostgreSQL lock waiter for ${queryPattern}; settled=${settled()}`);
}

describe("defensive raw-SQL party kind concurrency", () => {
  it.each(["explicit", "visit-fallback", "signer-fallback"] as const)(
    "holds the %s party kind stable through the sign transaction", async (candidate) => {
      const a = await party("doctor"), b = await party("doctor"), signer = await party("doctor");
      const p = await patient(), v = await visit(p, [procedure({ doctorId: b })], a);
      const changing = candidate === "explicit" ? b : candidate === "visit-fallback" ? a : signer;
      const gate = await rawClient(), mutator = await rawClient(), witness = await rawClient();
      let signing: ReturnType<typeof observe<Awaited<ReturnType<typeof sign>>>> | undefined;
      let mutation: ReturnType<typeof observe<unknown>> | undefined;
      try {
        await gate.query("BEGIN");
        await gate.query(`SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE`, [materialId]);
        const gatePid = (await gate.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
        signing = observe(sign(v, signer));
        // This barrier is after doctor validation, invoice, chart, and lab work,
        // but before commit. No mocked business SQL or timing assumptions.
        const signerPid = await blockedPid(witness, gatePid, "FROM[[:space:]]+inventory_items.*FOR UPDATE", signing.settled);
        await mutator.query("BEGIN");
        mutation = observe(mutator.query(`UPDATE parties SET kind = 'supplier' WHERE id = $1`, [changing]));
        await blockedPid(witness, signerPid, "UPDATE parties SET kind", mutation.settled);
        expect(await q(`SELECT signed_at FROM visits WHERE id = $1`, [v])).toEqual([{ signed_at: null }]);
        await gate.query("ROLLBACK");
        const signed = await signing.result;
        if (!signed.ok) throw signed.error;
        expect(signed.value).toMatchObject({ reason: null, duesMinor: 60000, materialsDeducted: 1 });
        const mutated = await mutation.result;
        if (!mutated.ok) throw mutated.error;
        // Release the synthetic mutation without changing historical identity.
        await mutator.query("ROLLBACK");
        expect(await q(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [signed.value.invoiceId]))
          .toEqual([{ doctor_id: b }]);
        expect(await q(`SELECT kind FROM parties WHERE id = $1`, [changing])).toEqual([{ kind: "doctor" }]);
      } finally {
        await gate.query("ROLLBACK").catch(() => {});
        await signing?.result;
        await mutation?.result;
        await mutator.query("ROLLBACK").catch(() => {});
        await Promise.all([gate.end(), mutator.end(), witness.end()]);
      }
    }, 60_000,
  );

  it("rejects after a raw-SQL kind change wins before the sign identity lock", async () => {
    const b = await party("doctor"), p = await patient(), v = await visit(p, [procedure({ doctorId: b })]);
    const before = await clinicalState(p);
    const mutator = await rawClient(), witness = await rawClient();
    let signing: ReturnType<typeof observe<Awaited<ReturnType<typeof sign>>>> | undefined;
    try {
      await mutator.query("BEGIN");
      await mutator.query(`UPDATE parties SET kind = 'lab' WHERE id = $1`, [b]);
      const pid = (await mutator.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      signing = observe(sign(v));
      await blockedPid(witness, pid, "FROM[[:space:]]+parties.*FOR SHARE", signing.settled);
      await mutator.query("COMMIT");
      const outcome = await signing.result;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Invalid performer was signed after the kind change committed");
      expect(outcome.error).toBeInstanceOf(ClinicalDoctorIdentityConflict);
      expect(await clinicalState(p)).toEqual(before);
    } finally {
      await mutator.query("ROLLBACK").catch(() => {});
      await signing?.result;
      await Promise.all([mutator.end(), witness.end()]);
    }
  }, 60_000);

  it("validates the locked reread when an older writer changes the draft after sign's preview", async () => {
    const p = await patient(), v = await visit(p, [procedure()]);
    const gate = await rawClient(), witness = await rawClient();
    let signing: ReturnType<typeof observe<Awaited<ReturnType<typeof sign>>>> | undefined;
    try {
      await gate.query("BEGIN");
      await gate.query(`SELECT id FROM visits WHERE id = $1 FOR UPDATE`, [v]);
      const pid = (await gate.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      signing = observe(sign(v));
      await blockedPid(witness, pid, "FROM visits WHERE.*FOR UPDATE", signing.settled);
      // Sign's initial preview has already read the valid B. The visit lock
      // serializes this synthetic older writer before sign's authoritative read.
      await gate.query(`UPDATE visit_procedures SET doctor_id = $2 WHERE visit_id = $1`, [v, supplierId]);
      await gate.query("COMMIT");
      const outcome = await signing.result;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Sign trusted its stale valid preview");
      expect(outcome.error).toBeInstanceOf(ClinicalDoctorIdentityConflict);
      expect(await q(`SELECT signed_at, signed_by, invoice_id FROM visits WHERE id = $1`, [v]))
        .toEqual([{ signed_at: null, signed_by: null, invoice_id: null }]);
      expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [v]))
        .toEqual([{ doctor_id: supplierId }]);
      expect(await q(`SELECT (SELECT COUNT(*) FROM invoices WHERE patient_id = $1)::int AS invoices,
        (SELECT COUNT(*) FROM tooth_conditions WHERE patient_id = $1)::int AS chart,
        (SELECT COUNT(*) FROM lab_orders WHERE patient_id = $1)::int AS lab,
        (SELECT COUNT(*) FROM inventory_movements WHERE patient_id = $1)::int AS inventory`, [p]))
        .toEqual([{ invoices: 0, chart: 0, lab: 0, inventory: 0 }]);
    } finally {
      await gate.query("ROLLBACK").catch(() => {});
      await signing?.result;
      await Promise.all([gate.end(), witness.end()]);
    }
  }, 60_000);
});
