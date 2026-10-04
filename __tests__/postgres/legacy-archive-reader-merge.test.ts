import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getPool, resetPoolForTesting, patientLegacyHistory, mergeDuplicatePatient } = await import("../../lib/db");
const q = async (sql: string, args: unknown[] = []) => (await getPool().query(sql, args)).rows;
let serial = 0;
const patient = async () => (await q("INSERT INTO patients (patient_number,full_name) VALUES ($1,$1) RETURNING id", [`ARCHIVE-COMPAT-${++serial}`]))[0].id as number;
const archive = async (id: number, remaining = 0) => (await q(`INSERT INTO legacy_treatments
  (patient_id,legacy_number,treated_on,doctor_name,service,currency,price_minor,paid_minor,remaining_minor,rate,imported_by)
  VALUES ($1,$2,'2025-01-01','Original doctor','Original treatment','SAR',60000,60000,$3,143.25,'original-import') RETURNING id`,
  [id, 9000 + id, remaining]))[0].id as number;
const visit = async (id: number) => q("INSERT INTO visits(patient_id,patient_name,status) VALUES ($1,'Synthetic','done')", [id]);
async function facts() {
  const result: Record<string, unknown> = {};
  for (const table of ["legacy_treatments", "legacy_payments", "patients", "visits", "payments", "invoices", "patient_opening_balances", "patient_opening_balance_history", "audit_log"]) {
    result[table] = await q(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`);
  }
  return result;
}
beforeAll(async () => { await dropPublicSchema(process.env.DATABASE_URL!); await ensureSchema(); });
afterAll(async () => { await resetPoolForTesting(); });

describe("archive reader and merge on the current 40-migration schema", () => {
  it("reads original numbers, rates and even original discrepancies unchanged without provenance columns", async () => {
    expect(await q("SELECT column_name FROM information_schema.columns WHERE table_name='legacy_treatments' AND column_name='source_kind'")).toEqual([]);
    const id = await patient(); const source = await archive(id, 7);
    const before = await facts();
    expect(await patientLegacyHistory(id)).toEqual({ treatments: [{ id: source, legacyNumber: 9000 + id,
      sourceKind: "legacy_import", historicalAsOf: null, treatedOn: "2025-01-01", doctorName: "Original doctor",
      service: "Original treatment", currency: "SAR", priceMinor: 60000, paidMinor: 60000, remainingMinor: 7,
      rate: 143.25, payments: [] }], orphanPayments: [] });
    expect(await facts()).toEqual(before);
  });
  it("keeps payment associations, orphan payments and patient scoping unchanged", async () => {
    const id = await patient(); const other = await patient(); const source = await archive(id); await archive(other);
    await q(`INSERT INTO legacy_payments(patient_id,legacy_treatment_id,legacy_number,paid_on,currency,amount_minor,rate,method,cash_box,imported_by)
      VALUES ($1,$2,8001,'2025-01-02','SAR',60000,142.75,'cash','Original box','original-import'),
      ($1,NULL,8002,'2025-01-03','USD',0,NULL,NULL,NULL,'original-import')`, [id, source]);
    const result = await patientLegacyHistory(id);
    expect(result.treatments).toHaveLength(1); expect(result.treatments[0].id).toBe(source);
    expect(result.treatments[0].payments).toEqual([{ legacyNumber: 8001, paidOn: "2025-01-02", currency: "SAR",
      amountMinor: 60000, rate: 142.75, method: "cash", cashBox: "Original box" }]);
    expect(result.orphanPayments).toEqual([{ legacyNumber: 8002, paidOn: "2025-01-03", currency: "USD",
      amountMinor: 0, rate: null, method: null, cashBox: null }]);
    expect(await patientLegacyHistory(2147483647)).toEqual({ treatments: [], orphanPayments: [] });
  });
  it("refuses a fully paid imported archive before the first FK reassignment", async () => {
    const source = await patient(); const target = await patient(); await archive(source); await visit(source);
    await q(`CREATE FUNCTION test_reject_archive_visit_move() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'unexpected FK reassignment'; END $$;
      CREATE TRIGGER test_reject_archive_visit_move BEFORE UPDATE OF patient_id ON visits
      FOR EACH ROW EXECUTE FUNCTION test_reject_archive_visit_move()`);
    try {
      const before = await facts();
      expect(await mergeDuplicatePatient(source, target, { actor: "synthetic-admin" })).toEqual({ ok: false,
        reason: "source_has_financial_history", counts: { payments: 0, inventoryMovements: 0, openingBalances: 0, legacyTreatments: 1, legacyPayments: 0 } });
      expect(await facts()).toEqual(before);
    } finally { await q("DROP TRIGGER test_reject_archive_visit_move ON visits; DROP FUNCTION test_reject_archive_visit_move()"); }
  });
  it("refuses an orphan historical payment even with zero amount and no treatment or live debt", async () => {
    const source = await patient(); const target = await patient(); await visit(source);
    await q("INSERT INTO legacy_payments(patient_id,legacy_number,currency,amount_minor,imported_by) VALUES ($1,8101,'SAR',0,'original-import')", [source]);
    const before = await facts();
    expect(await mergeDuplicatePatient(source, target, { actor: "synthetic-admin" })).toEqual({ ok: false,
      reason: "source_has_financial_history", counts: { payments: 0, inventoryMovements: 0, openingBalances: 0, legacyTreatments: 0, legacyPayments: 1 } });
    expect(await facts()).toEqual(before);
  });
  it("allows a clean source to merge into a target with archive facts without reassigning those facts", async () => {
    const source = await patient(); const target = await patient(); await archive(target); await visit(source);
    const before = await patientLegacyHistory(target);
    expect(await mergeDuplicatePatient(source, target, { actor: "synthetic-admin" })).toMatchObject({ ok: true, moved: { "visits.patient_id": 1 } });
    expect(await patientLegacyHistory(target)).toEqual(before);
    expect(await q("SELECT id FROM patients WHERE id=$1", [source])).toEqual([]);
  });
  it("waits for a concurrent archive insert and then refuses the merge using committed source facts", async () => {
    const source = await patient(); const target = await patient(); await visit(source);
    const connection = await getPool().connect(); let pending: ReturnType<typeof mergeDuplicatePatient> | undefined;
    try {
      await connection.query("BEGIN");
      const pid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await connection.query(`INSERT INTO legacy_treatments(patient_id,legacy_number,currency,price_minor,paid_minor,remaining_minor,imported_by)
        VALUES ($1,8201,'SAR',60000,60000,0,'original-import')`, [source]);
      pending = mergeDuplicatePatient(source, target, { actor: "synthetic-admin" });
      await expect.poll(async () => (await q(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))) AS waiting`, [pid]))[0].waiting,
      { timeout: 5000, interval: 20 }).toBe(true);
      await connection.query("COMMIT");
      expect(await pending).toMatchObject({ ok: false, reason: "source_has_financial_history", counts: { legacyTreatments: 1 } });
      expect(await q("SELECT patient_id FROM visits WHERE patient_id=$1", [source])).toHaveLength(1);
    } finally {
      await connection.query("ROLLBACK"); connection.release();
      if (pending) await pending;
    }
  });
});

describe("reader compatibility with optional future columns only in synthetic test fixtures", () => {
  beforeAll(async () => {
    // This is deliberately not a migration or a manual writer. Relaxed fixture
    // columns allow corrupt provenance to prove that the reader fails closed.
    await q(`ALTER TABLE legacy_treatments ALTER COLUMN legacy_number DROP NOT NULL;
      ALTER TABLE legacy_treatments ADD COLUMN source_kind TEXT DEFAULT 'legacy_import';
      ALTER TABLE legacy_treatments ADD COLUMN historical_as_of DATE;
      ALTER TABLE legacy_treatments ADD COLUMN source_note TEXT;
      ALTER TABLE legacy_treatments ADD COLUMN intake_key TEXT;
      ALTER TABLE legacy_treatments ADD COLUMN intake_request_hash TEXT`);
  });
  async function futureSource(id: number, kind: string | null, number: number | null, asOf: string | null) {
    return (await q(`INSERT INTO legacy_treatments(patient_id,legacy_number,currency,price_minor,paid_minor,remaining_minor,imported_by,
      source_kind,historical_as_of,source_note,intake_key,intake_request_hash)
      VALUES ($1,$2,'SAR',60000,60000,0,'synthetic-fixture',$3,$4,'PRIVATE_SOURCE_NOTE','PRIVATE_REQUEST_KEY','PRIVATE_REQUEST_HASH') RETURNING id`,
    [id, number, kind, asOf]))[0].id as number;
  }
  it("preserves the imported view when default provenance columns become available", async () => {
    const id = await patient(); const source = await archive(id, 7);
    expect((await patientLegacyHistory(id)).treatments[0]).toMatchObject({ id: source, legacyNumber: 9000 + id,
      sourceKind: "legacy_import", historicalAsOf: null, priceMinor: 60000, paidMinor: 60000, remainingMinor: 7, rate: 143.25 });
  });
  it("returns internal identity and an honest cutoff for nullable manual rows without leaking private provenance", async () => {
    const id = await patient(); const first = await futureSource(id, "manual_history", null, "2026-09-01");
    const second = await futureSource(id, "manual_history", null, "2026-09-02"); const before = await facts();
    const result = await patientLegacyHistory(id);
    expect(result.treatments.map(({ id, legacyNumber, sourceKind, historicalAsOf }) => ({ id, legacyNumber, sourceKind, historicalAsOf })))
      .toEqual([{ id: first, legacyNumber: null, sourceKind: "manual_history", historicalAsOf: "2026-09-01" },
        { id: second, legacyNumber: null, sourceKind: "manual_history", historicalAsOf: "2026-09-02" }]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|intake|sourceNote|source_note/);
    expect(result.treatments.every((row) => row.payments.length === 0 && row.remainingMinor === 0)).toBe(true);
    expect(await facts()).toEqual(before);
  });
  it.each([
    ["unknown", null, "2026-09-01"], [null, 8301, null], ["", 8302, null],
    ["legacy_import", null, null], ["legacy_import", 8303, "2026-09-01"],
    ["manual_history", 8304, "2026-09-01"], ["manual_history", null, null], ["manual_history", null, "infinity"],
  ])("rejects malformed source %j, number %j, cutoff %j explicitly", async (kind, number, asOf) => {
    const id = await patient(); await futureSource(id, kind as string | null, number as number | null, asOf as string | null);
    await expect(patientLegacyHistory(id)).rejects.toThrow("Invalid legacy archive provenance");
  });
  it("refuses a fully paid manual archive with the same clear preflight result", async () => {
    const source = await patient(); const target = await patient(); await futureSource(source, "manual_history", null, "2026-09-01");
    await visit(source); const before = await facts();
    expect(await mergeDuplicatePatient(source, target, { actor: "synthetic-admin" })).toMatchObject({ ok: false,
      reason: "source_has_financial_history", counts: { legacyTreatments: 1, payments: 0, openingBalances: 0 } });
    expect(await facts()).toEqual(before);
  });
});
