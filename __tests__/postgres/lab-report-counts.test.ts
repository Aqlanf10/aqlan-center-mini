/** PROPOSED, NOT EXECUTED. Use the existing guarded PG18 suite only, against an
 * explicitly authorized disposable synthetic target. No new database harness. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { labSummary, type LabOrderClinicalDTO } from "../../lib/lab";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import {
  REPORT_LAB_TODAY, ZERO_LAB_COUNTS, reportDisplacedReceived, reportLateOrders,
  reportLabOrder, reportStatusMatrix,
} from "../fixtures/lab-report-counts";

// Follow lab-batch-full-allocation: validate ORIGINAL environment before stubbing
// removes Railway markers. The unchanged global setup also enforces PG major 18.
const originalEnvironment = { ...process.env };
assertRealPostgresUrl();
const target = validatePostgresTestTarget(originalEnvironment, { allowDatabaseUrlFallback: true });
stubPostgresEnv();
const db = await import("../../lib/db");

// Proposed test boundary: an old zero-argument function can legally be assigned
// to this signature, then ignores the extra argument at runtime. This keeps the
// baseline capable of semantic red assertions rather than an argument type error.
// It is NOT a fallback implementation, monkey patch, or second aggregate owner.
const workflowCounts: (options: { mode: "workflow"; today: string }) => ReturnType<typeof db.labCounts>
  = db.labCounts;
const counts = (today = REPORT_LAB_TODAY) => workflowCounts({ mode: "workflow", today });
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query<T>(sql, values)).rows;

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
});
beforeEach(async () => {
  // Existing disposable-PG fixture lifecycle; never disable integrity triggers.
  await q("TRUNCATE lab_order_tracking, lab_orders, patients RESTART IDENTITY CASCADE");
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function seed(orders: LabOrderClinicalDTO[]): Promise<void> {
  const [patient] = await q<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ('SYN-REPORT-LAB', 'Synthetic report patient') RETURNING id",
  );
  if (orders.length === 0) return;
  // The actual read owner consumes real SQL rows; no stubbed SQL totals. This is
  // read-only operational coverage, so no payment/status writer is under test.
  await q(`INSERT INTO lab_orders
      (patient_id, lab_name, work_type, sent_date, due_date, status, received_at, delivered_at, created_at)
    SELECT $1, 'Synthetic report lab', 'Synthetic crown', '1999-12-01'::date,
      fixture.due_date::date, fixture.status, fixture.received_at::timestamptz,
      fixture.delivered_at::timestamptz, '1999-12-01T00:00:00Z'::timestamptz
    FROM jsonb_to_recordset($2::jsonb) AS fixture(
      due_date text, status text, received_at text, delivered_at text)`,
  [patient.id, JSON.stringify(orders.map((order) => ({ due_date: order.dueDate,
    status: order.status, received_at: order.receivedAt, delivered_at: order.deliveredAt })))]);
}

async function snapshot() {
  return {
    orders: await q("SELECT * FROM lab_orders ORDER BY id"),
    tracking: await q("SELECT * FROM lab_order_tracking ORDER BY id"),
    payables: await q("SELECT * FROM payables ORDER BY id"),
    expenses: await q("SELECT * FROM expenses ORDER BY id"),
    allocations: await q("SELECT * FROM expense_payable_allocations ORDER BY id"),
    audit: await q("SELECT * FROM audit_log ORDER BY id"),
  };
}

async function completeRead(orders: LabOrderClinicalDTO[], today = REPORT_LAB_TODAY) {
  await seed(orders);
  const before = await snapshot();
  const query = vi.spyOn(db.getPool(), "query");
  let result: Awaited<ReturnType<typeof db.labCounts>>;
  try {
    result = await counts(today);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/\bcount\s*\(/i);
    expect(sql).toMatch(/\bFROM\s+lab_orders\b/i);
    expect(sql).not.toMatch(/\bLIMIT\b|\bORDER\s+BY\b/i);
  } finally { query.mockRestore(); }
  expect(await snapshot()).toEqual(before);
  expect(result).toEqual(labSummary(orders, today));
  expect(Object.keys(result).sort()).toEqual(["dueToday", "late", "outstanding", "waitingFitting"]);
  return result;
}

describe("complete operational lab SQL counts", () => {
  it.each([301, 501])("counts %i sent overdue rows without a list cap", async (count) => {
    expect(await completeRead(reportLateOrders(count)))
      .toEqual({ outstanding: count, late: count, dueToday: 0, waitingFitting: 0 });
  });

  it("counts received work displaced by 300 earlier delivered rows", async () => {
    expect(await completeRead(reportDisplacedReceived())).toEqual({ ...ZERO_LAB_COUNTS, waitingFitting: 1 });
  });

  it.each(["in_progress", "remake"] as const)("counts 501 %s rows under workflow semantics", async (status) => {
    expect(await completeRead(reportLateOrders(501, status)))
      .toEqual({ outstanding: 501, late: 501, dueToday: 0, waitingFitting: 0 });
  });

  it("matches every status at yesterday/today/tomorrow for the supplied as-of day", async () => {
    expect(await completeRead(reportStatusMatrix()))
      .toEqual({ outstanding: 9, late: 3, dueToday: 3, waitingFitting: 3 });
  });

  it("uses the caller's supplied day even when it differs from the database clock", async () => {
    expect(await completeRead(reportStatusMatrix("2000-01-02"), "2000-01-02"))
      .toEqual({ outstanding: 9, late: 3, dueToday: 3, waitingFitting: 3 });
  });

  it("keeps old and future received rows waiting for fitting regardless of timestamps", async () => {
    const orders = [
      { ...reportLabOrder(1, "received", "2000-01-01"), receivedAt: "2000-01-01T00:00:00Z" },
      reportLabOrder(2, "received", REPORT_LAB_TODAY),
      { ...reportLabOrder(3, "received", "2099-01-01"), receivedAt: "2026-10-04T21:00:00Z" },
    ];
    expect(await completeRead(orders)).toEqual({ ...ZERO_LAB_COUNTS, waitingFitting: 3 });
  });

  it("returns exact zeros only for a successful empty read", async () => {
    expect(await completeRead([])).toEqual(ZERO_LAB_COUNTS);
  });

  it("does not turn a query failure into successful zero counts", async () => {
    const query = vi.spyOn(db.getPool(), "query").mockRejectedValueOnce(new Error("Synthetic count read failure"));
    try { await expect(counts()).rejects.toThrow("Synthetic count read failure"); }
    finally { query.mockRestore(); }
  });

  it("preserves the no-argument sent-only badge mode and its SQL clinic clock", async () => {
    const [clock] = await q<{ today: string }>(
      "SELECT to_char((NOW() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today", [db.CLINIC_TIME_ZONE],
    );
    await seed(reportStatusMatrix(clock.today));
    const query = vi.spyOn(db.getPool(), "query");
    let result: Awaited<ReturnType<typeof db.labCounts>>;
    try {
      result = await db.labCounts();
      expect(query).toHaveBeenCalledTimes(1);
      expect(String(query.mock.calls[0][0])).toMatch(/NOW\(\)\s+AT\s+TIME\s+ZONE/i);
      expect(query.mock.calls[0][1]).toContain(db.CLINIC_TIME_ZONE);
    } finally { query.mockRestore(); }
    // A crossing here is a clock-fixture/setup retry, never evidence of the defect.
    const [after] = await q<{ today: string }>(
      "SELECT to_char((NOW() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today", [db.CLINIC_TIME_ZONE],
    );
    expect(after.today, "Fixture crossed clinic midnight; rerun this control on a stable day").toBe(clock.today);
    expect(result).toEqual({ outstanding: 3, late: 1, dueToday: 1, waitingFitting: 3 });
  });
});
