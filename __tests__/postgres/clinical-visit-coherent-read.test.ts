import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { assertPostgres18VersionNum } from "../../scripts/verify-schema-ownership";
import type { ClinicalVisit, QueryResult } from "../../lib/db";

const routeSession = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: routeSession.requireSession }));

// Real SQL, canonical disposable target, PG18 only. Every visit is inserted with
// its synthetic patient_id already present. No relink/unlinked-visit harness,
// HTTP server, real documents, clinical production data, or production endpoint.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
process.env.SKIP_SEED = "true";
const db = await import("../../lib/db");
const { GET } = await import("../../app/api/visits/[id]/clinical/route");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query<T>(sql, values)).rows;
let sequence = 0;
let doctorA: number;
let doctorB: number;
let serviceId: number;

beforeAll(async () => {
  // Revalidate the unchanged target before the repository's disposable reset.
  // Refuse a non-PG18 server before any schema reset, even outside global setup.
  const resetTarget = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
  if (resetTarget.testUrl.toString() !== target.testUrl.toString()) throw new Error("Disposable test target changed before reset");
  const verifier = new Client({ connectionString: resetTarget.testUrl.toString(), ssl: false });
  await verifier.connect();
  try {
    const { rows } = await verifier.query<{ version: string }>("SELECT current_setting('server_version_num') AS version");
    assertPostgres18VersionNum(rows[0]?.version ?? "0");
  } finally { await verifier.end(); }
  await dropPublicSchema(resetTarget.testUrl.toString());
  await db.ensureSchema();
  const providers = await q<{ id: number }>(`INSERT INTO parties(kind,name) VALUES
    ('doctor','Coherent doctor A'),('doctor','Coherent doctor B') RETURNING id`);
  [doctorA, doctorB] = providers.map((row) => row.id);
  serviceId = (await q<{ id: number }>(`INSERT INTO services
    (name,category,price_minor,price_usd_minor,price_sar_minor,price_configured,is_active)
    VALUES('Coherent synthetic service','cleaning',15000,12000,11000,TRUE,TRUE) RETURNING id`))[0].id;
  routeSession.requireSession.mockResolvedValue({ role: "admin", username: "coherent-read-admin", partyId: doctorA });
}, 180_000);
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });

async function linkedVisit() {
  const patientId = (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name,primary_doctor_id)
    VALUES($1,'Synthetic coherent patient',$2) RETURNING id`, [`COHERENT-${++sequence}`, doctorA]))[0].id;
  const visitId = (await q<{ id: number }>(`INSERT INTO visits
    (patient_id,patient_name,doctor_id,status,billing_currency,chief_complaint,examination,diagnosis,treatment_done,next_plan)
    VALUES($1,'Synthetic coherent patient',$2,'seated','USD','old chief','old examination','old diagnosis','old treatment','old plan')
    RETURNING id`, [patientId, doctorA]))[0].id;
  const procedureId = (await q<{ id: number }>(`INSERT INTO visit_procedures
    (visit_id,service_id,doctor_id,tooth_code,surfaces,quantity,unit_price_minor,note)
    VALUES($1,$2,$3,16,'MO',1,12000,'old procedure') RETURNING id`, [visitId, serviceId, doctorA]))[0].id;
  return { patientId, visitId, procedureId };
}

async function richLinkedVisit(frozenAdjustment: boolean) {
  const f = await linkedVisit();
  const caseId = (await q<{ id: number }>(`INSERT INTO clinical_cases
    (patient_id,specialty,title,responsible_party_id,created_by)
    VALUES($1,'endodontics','Synthetic active case',$2,'synthetic') RETURNING id`, [f.patientId, doctorA]))[0].id;
  const planId = (await q<{ id: number }>(`INSERT INTO treatment_plans
    (patient_id,title,total_minor,base_currency,primary_doctor_id,consent_at,consent_by)
    VALUES($1,'Synthetic coherent plan',37000,'USD',$2,NOW(),'synthetic') RETURNING id`, [f.patientId, doctorA]))[0].id;
  const items = await q<{ id: number }>(`INSERT INTO plan_items
    (plan_id,service_id,service_name,category,tooth_code,unit_price_minor,session_count,billing_rule,case_id,doctor_id,sort_order)
    VALUES($1,$2,'Synthetic staged course','cleaning',16,24000,2,'per_session',$3,$4,1),
      ($1,$2,'Synthetic prerequisite','cleaning',17,1000,1,'on_completion',$3,$4,2),
      ($1,$2,'Synthetic matching step','cleaning',18,12000,1,'on_completion',$3,$4,3) RETURNING id`,
  [planId, serviceId, caseId, doctorA]);
  const [itemId, requiredItemId] = items.map((row) => row.id);
  await q(`INSERT INTO plan_item_dependencies(item_id,requires_item_id,requirement,created_by)
    VALUES($1,$2,'completed','synthetic')`, [itemId, requiredItemId]);
  await q(`INSERT INTO treatment_sessions(plan_item_id,sequence,title) VALUES($1,1,'Synthetic session one'),($1,2,'Synthetic session two')`, [itemId]);
  await q(`INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-10-01',37000)`, [planId]);
  const plannedId = (await q<{ id: number }>(`INSERT INTO planned_visits
    (patient_id,plan_id,sequence,title,doctor_id,duration_minutes)
    VALUES($1,$2,1,'Synthetic current planned visit',$3,45) RETURNING id`, [f.patientId, planId, doctorA]))[0].id;
  await q(`INSERT INTO planned_visits(patient_id,plan_id,sequence,title,doctor_id,after_days)
    VALUES($1,$2,2,'Synthetic next planned visit',$3,7)`, [f.patientId, planId, doctorB]);
  await q(`UPDATE visits SET planned_visit_id=$2,case_id=$3 WHERE id=$1`, [f.visitId, plannedId, caseId]);
  await q(`UPDATE visit_procedures SET plan_item_id=$2 WHERE id=$1`, [f.procedureId, itemId]);
  await q(`INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,unit_price_minor,note)
    VALUES($1,$2,$3,18,1,12000,'Synthetic free matching step')`, [f.visitId, serviceId, doctorA]);
  const previousId = (await q<{ id: number }>(`INSERT INTO visits
    (patient_id,patient_name,doctor_id,arrived_at,signed_at,signed_by,diagnosis,treatment_done,next_plan)
    VALUES($1,'Synthetic coherent patient',$2,NOW()-INTERVAL '1 day',NOW()-INTERVAL '1 day',
      'synthetic prior signer','Synthetic prior diagnosis','Synthetic prior treatment','Synthetic prior plan') RETURNING id`,
  [f.patientId, doctorA]))[0].id;
  const orthoCaseId = (await q<{ id: number }>(`INSERT INTO ortho_cases
    (patient_id,plan_id,responsible_doctor_id,upper_wire,lower_wire,created_by)
    VALUES($1,$2,$3,'014_niti','014_niti','synthetic') RETURNING id`, [f.patientId, planId, doctorA]))[0].id;
  const adjustmentVisitId = frozenAdjustment ? f.visitId : previousId;
  if (frozenAdjustment) await q(`UPDATE visits SET signed_at=NOW(),signed_by='synthetic fixture signer' WHERE id=$1`, [f.visitId]);
  const adjustmentId = (await q<{ id: number }>(`INSERT INTO ortho_adjustments
    (case_id,visit_id,done,elastic_note,recorded_by,billing_class,billing_decision,billing_decision_reason,billing_decided_by,billing_decided_at)
    VALUES($1,$2,'Synthetic adjustment','Synthetic elastics','synthetic',$3,$4,$5,$6,$7) RETURNING id`,
  [orthoCaseId, adjustmentVisitId, frozenAdjustment ? "OUTSIDE_CONTRACT" : null,
    frozenAdjustment ? "no_charge" : null, frozenAdjustment ? "Synthetic no-charge reason" : null,
    frozenAdjustment ? "synthetic" : null, frozenAdjustment ? new Date("2026-10-03T10:00:00Z") : null]))[0].id;
  // Metadata only: no file is uploaded, opened, generated, or stored by this suite.
  await q(`INSERT INTO patient_documents
    (patient_id,visit_id,ortho_case_id,adjustment_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES($1,$2,$3,$4,'photo','Synthetic adjustment photo','image/png',1,$5,$6,'synthetic')`,
  [f.patientId, adjustmentVisitId, orthoCaseId, adjustmentId, "a".repeat(64), `synthetic/coherent-${sequence}.png`]);
  const referralId = (await q<{ id: number }>(`INSERT INTO patient_referrals
    (patient_id,to_name,to_specialty,reason,doctor_party_id,doctor_name,created_by,kind,to_party_id,workflow_state,case_id,blocks_case_id,plan_item_id)
    VALUES($1,'Coherent doctor A','endodontics','Synthetic referral reason',$2,'Coherent doctor B','synthetic',
      'internal',$3,'arrived',$4,$4,$5) RETURNING id`, [f.patientId, doctorB, doctorA, caseId, itemId]))[0].id;
  const labId = (await q<{ id: number }>(`INSERT INTO lab_orders(patient_id,visit_id,lab_name,work_type,tooth_code,due_date)
    VALUES($1,$2,'Synthetic laboratory','Synthetic crown',16,CURRENT_DATE+7) RETURNING id`, [f.patientId, f.visitId]))[0].id;
  return { ...f, caseId, planId, itemId, plannedId, previousId, orthoCaseId, adjustmentId, referralId, labId };
}

async function stateSnapshot() {
  // Include clinical context and financial/audit surfaces whose accidental writes
  // must not be hidden by a successful response. This is a synthetic DB only.
  const tables = ["patients", "visits", "visit_procedures", "treatment_plans", "plan_items", "plan_installments",
    "treatment_sessions", "planned_visits", "clinical_cases", "ortho_cases", "ortho_adjustments", "patient_documents",
    "patient_referrals", "lab_orders", "invoices", "invoice_items", "payments", "audit_log"] as const;
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
  result.plan_item_dependencies = await q("SELECT * FROM plan_item_dependencies ORDER BY item_id,requires_item_id");
  return result;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const headerSql = /SELECT id, patient_id, patient_name, patient_phone, chief_complaint/;
type State = { pid: number; isolation: string; readOnly: string };
function instrumentNextRead(options: { pause?: boolean; failAt?: RegExp; failure?: Error; rollbackFailure?: Error } = {}) {
  const paused = deferred(); const release = deferred();
  const statements: string[] = [];
  let captured = false; let state: State | null = null; let releases = 0;
  const pool = db.getPool(); const connect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect").mockImplementation(async (...args: unknown[]) => {
    // pg.Pool.query has a callback connect path; preserve it. Capture only the
    // first application's explicit client, so a competing real save is untouched.
    if (args.length > 0) return Reflect.apply(connect, pool, args);
    const client = await connect();
    if (captured) return client;
    captured = true;
    const query = client.query.bind(client);
    return {
      async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
        statements.push(sql);
        if (options.failAt?.test(sql)) throw options.failure ?? new Error("Synthetic coherent read failure");
        const result = await query<T>(sql, values);
        if (headerSql.test(sql)) {
          state = (await query<State>(`SELECT pg_backend_pid() AS pid,
            current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS "readOnly"`)).rows[0];
          paused.resolve();
          if (options.pause) await release.promise;
        }
        // The real ROLLBACK runs first. Simulate a reporting failure without
        // deliberately returning an open transaction to the shared test pool.
        if (sql === "ROLLBACK" && options.rollbackFailure) throw options.rollbackFailure;
        return result;
      },
      release() { releases++; client.release(); },
    };
  });
  return { paused, release, statements, spy, state: () => state, releases: () => releases };
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function assertReleasedIdle(pid: number) {
  const observer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await observer.connect();
  try {
    const { rows } = await observer.query<{ state: string; xact_start: Date | null }>(
      "SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1", [pid]);
    expect(rows).toEqual([{ state: "idle", xact_start: null }]);
  } finally { await observer.end(); }
}
const routeGet = (visitId: number) => GET(new Request(`http://localhost/api/visits/${visitId}/clinical`),
  { params: Promise.resolve({ id: String(visitId) }) });

describe("canonical clinical visit coherent read on real PostgreSQL 18", () => {
  it("actual GET keeps old header and procedures across a complete atomic save; next GET sees all new state", async () => {
    const f = await linkedVisit();
    const gate = instrumentNextRead({ pause: true });
    const reading = routeGet(f.visitId);
    let saving: Promise<boolean> | undefined;
    try {
      await within(Promise.race([gate.paused.promise, reading.then(() => { throw new Error("GET finished before snapshot barrier"); })]), "Read snapshot barrier");
      expect(gate.state()).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
      // Read the writer PID on its actual save client, not an unrelated observer.
      const pool = db.getPool();
      gate.spy.mockRestore();
      let writerPid = 0;
      const writerConnect = pool.connect.bind(pool);
      const writerSpy = vi.spyOn(pool, "connect").mockImplementation(async (...args: unknown[]) => {
        if (args.length > 0) return Reflect.apply(writerConnect, pool, args);
        const client = await writerConnect();
        writerPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        return client;
      });
      try {
        saving = db.saveClinicalDraft({ visitId: f.visitId, authorizedPatientId: f.patientId,
          actor: { username: "synthetic coherent writer", role: "admin" },
          chiefComplaint: "new chief", examination: "new examination", diagnosis: "new diagnosis",
          treatmentDone: "new treatment", nextPlan: "new plan", doctorId: doctorB, billingCurrency: "SAR",
          procedures: [{ serviceId, doctorId: doctorB, toothCode: 17, surfaces: null, quantity: 2,
            unitPriceMinor: 11000, note: "new procedure", planItemId: null, priceReason: null }] });
        expect(await within(saving, "Competing atomic save while GET is paused")).toBe(true);
        expect(writerPid).toBeGreaterThan(0);
        expect(writerPid).not.toBe(gate.state()?.pid);
      } finally { writerSpy.mockRestore(); }
      const committed = await stateSnapshot();
      gate.release.resolve();
      const oldResponse = await reading;
      expect(oldResponse.status).toBe(200);
      expect(await oldResponse.json()).toMatchObject({ id: f.visitId, patientId: f.patientId,
        chiefComplaint: "old chief", examination: "old examination", diagnosis: "old diagnosis",
        treatmentDone: "old treatment", nextPlan: "old plan", doctorId: doctorA, billingCurrency: "USD", totalMinor: 12000,
        procedures: [{ id: f.procedureId, doctorId: doctorA, toothCode: 16, surfaces: "MO", quantity: 1, unitPriceMinor: 12000, note: "old procedure" }] });
      expect(gate.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(gate.statements.at(-1)).toBe("COMMIT");
      expect(gate.releases()).toBe(1);
      const newResponse = await routeGet(f.visitId);
      expect(newResponse.status).toBe(200);
      const fresh = await newResponse.json() as ClinicalVisit;
      expect(fresh).toMatchObject({ chiefComplaint: "new chief", examination: "new examination", diagnosis: "new diagnosis",
        treatmentDone: "new treatment", nextPlan: "new plan", doctorId: doctorB, billingCurrency: "SAR", totalMinor: 22000,
        procedures: [{ doctorId: doctorB, toothCode: 17, surfaces: null, quantity: 2, unitPriceMinor: 11000, note: "new procedure" }] });
      expect(fresh.procedures).toHaveLength(1);
      expect(fresh.procedures[0].id).not.toBe(f.procedureId);
      expect(await stateSnapshot()).toEqual(committed);
    } finally {
      gate.release.resolve(); gate.spy.mockRestore();
      await reading.catch(() => undefined); await saving?.catch(() => undefined);
    }
  });

  it("keeps the existing real PostgreSQL pool's snapshot path if USE_LOCAL_DB changes after creation", async () => {
    const f = await linkedVisit();
    const pool = db.getPool();
    const originalLocalFlag = process.env.USE_LOCAL_DB;
    const trace = instrumentNextRead();
    process.env.USE_LOCAL_DB = "true";
    try {
      expect(db.getPool()).toBe(pool);
      expect(await db.getClinicalVisit(f.visitId)).toMatchObject({ id: f.visitId, patientId: f.patientId });
      expect(trace.state()).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
      expect(trace.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(trace.statements.at(-1)).toBe("COMMIT");
      expect(trace.spy).toHaveBeenCalledTimes(1);
      expect(trace.releases()).toBe(1);
    } finally {
      if (originalLocalFlag === undefined) delete process.env.USE_LOCAL_DB;
      else process.env.USE_LOCAL_DB = originalLocalFlag;
      trace.spy.mockRestore();
    }
    await assertReleasedIdle(trace.state()!.pid);
  });

  it.each([false, true])("rich linked context stays on one read-only client with no pool escape (frozen adjustment=%s)", async (frozen) => {
    const f = await richLinkedVisit(frozen);
    const before = await stateSnapshot();
    const trace = instrumentNextRead();
    const poolEscape = vi.spyOn(db.getPool(), "query").mockImplementation(async () => { throw new Error("Canonical read escaped its client"); });
    try {
      const visit = await db.getClinicalVisit(f.visitId, { actorPartyId: doctorB });
      expect(visit).toMatchObject({ patientId: f.patientId, planCurrency: "USD", planTitle: "Synthetic coherent plan", planItemsMatched: 1,
        plannedVisit: { id: f.plannedId, title: "Synthetic current planned visit", durationMinutes: 45 },
        previousVisit: { id: f.previousId, treatmentDone: "Synthetic prior treatment" },
        latestDiagnosis: { text: "Synthetic prior diagnosis" },
        ortho: { caseId: f.orthoCaseId, lastDone: "Synthetic adjustment",
          visitAdjustmentId: frozen ? f.adjustmentId : null, adjustmentBillingClass: frozen ? "NO_CHARGE" : "INCLUDED" },
        referral: { id: f.referralId, reason: "Synthetic referral reason", workflowState: "arrived" },
        labOrders: [{ id: f.labId, labName: "Synthetic laboratory" }] });
      expect(visit?.activeCases).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.caseId, totalSteps: 3, doneSteps: 0 })]));
      expect(visit?.outstanding).toEqual(expect.arrayContaining([expect.objectContaining({ planItemId: f.itemId,
        sessionCount: 2, includedByAgreement: true, unmetRequirements: [expect.stringContaining("Synthetic prerequisite")] })]));
      expect(visit?.sessionPricing).toEqual([expect.objectContaining({ planItemId: f.itemId, sessionIndex: 1, priceMinor: 0 })]);
      expect(trace.state()).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
      expect(trace.releases()).toBe(1);
      expect(trace.spy).toHaveBeenCalledTimes(1);
      expect(poolEscape).not.toHaveBeenCalled();
      expect(trace.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(trace.statements.at(-1)).toBe("COMMIT");
      expect(trace.statements.slice(1, -1).every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
      const sql = trace.statements.join("\n");
      for (const required of ["FROM patient_documents d", "FROM ortho_adjustments a", "FROM clinical_cases c",
        "FROM plan_item_dependencies dep", "FROM patient_referrals r", "FROM lab_orders", "FROM planned_visits nv"]) {
        expect(sql).toContain(required);
      }
      expect(sql).toContain(frozen ? "SELECT billing_class, billing_decision" : "AS funded_plan");
    } finally { poolEscape.mockRestore(); trace.spy.mockRestore(); }
    await assertReleasedIdle(trace.state()!.pid);
    expect(await stateSnapshot()).toEqual(before);
  });

  it.each([false, true])("rolls back a late query rejection and releases once, retaining the original error (rollback reporting failure=%s)", async (rollbackReportsFailure) => {
    const f = await richLinkedVisit(false);
    const before = await stateSnapshot();
    const failure = new Error("Synthetic late referral read failure");
    const trace = instrumentNextRead({ failAt: /SELECT r.id, r.doctor_name, r.reason/, failure,
      rollbackFailure: rollbackReportsFailure ? new Error("Synthetic rollback reporting failure") : undefined });
    try {
      await expect(db.getClinicalVisit(f.visitId)).rejects.toBe(failure);
      expect(trace.statements).toContain("ROLLBACK");
      expect(trace.statements).not.toContain("COMMIT");
      expect(trace.statements.at(-1)).toBe("ROLLBACK");
      expect(trace.releases()).toBe(1);
    } finally { trace.spy.mockRestore(); }
    await assertReleasedIdle(trace.state()!.pid);
    expect(await stateSnapshot()).toEqual(before);
    expect(await db.getClinicalVisit(f.visitId)).toMatchObject({ id: f.visitId, patientId: f.patientId });
  });

  it("not-found commits the read-only transaction and releases without traversing unrelated context", async () => {
    const before = await stateSnapshot();
    const trace = instrumentNextRead();
    try {
      expect(await db.getClinicalVisit(2147483647)).toBeNull();
      expect(trace.statements).toHaveLength(3);
      expect(trace.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(trace.statements[1]).toMatch(headerSql);
      expect(trace.statements[2]).toBe("COMMIT");
      expect(trace.releases()).toBe(1);
    } finally { trace.spy.mockRestore(); }
    await assertReleasedIdle(trace.state()!.pid);
    expect((await routeGet(2147483647)).status).toBe(404);
    expect(await stateSnapshot()).toEqual(before);
  });
});
