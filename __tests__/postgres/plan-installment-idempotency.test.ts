import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIN-1) تحصيل قسط الخطة من ملف المريض: إعادة المحاولة لا تُنشئ سندًا ثانيًا.
 *
 * كان POST /api/plans/[id] يسجّل فاتورةً وسند قبضٍ في كل طلب بلا مفتاح إعادة: ينقطع
 * الرد بعد الالتزام («تعذّر الاتصال بالخادم»)، فيضغط المحصّل «تحصيل» ثانيةً — فاتورتان
 * وسندان عن نقدٍ قُبض مرة واحدة، ودرجٌ «متوقَّعه» أكبر من الحقيقة. الدفعات العادية
 * محميةٌ بهذا منذ P1-1؛ هذا المسار وحده بقي بلا حماية.
 *
 * الآن: المفتاح نفسه بالعملية نفسها ⇒ السند الأول نفسه (replay)؛ وبعملية مختلفة ⇒
 * idempotency_conflict — والمفاتيح في فضاء السندات نفسه مع recordPayment.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment, recordPlanInstallment, createPlanV2,
} = await import("../../lib/db");

let patientId: number;
let planId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "fin1", opening: { YER: 0, SAR: 0, USD: 0 } });
  const pool = getPool();
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('FIN1-1', 'مريض أقساط') RETURNING id`,
  );
  patientId = patient.id;
  const plan = await createPlanV2({
    patientId, title: "تقويم ثابت", specialty: null, primaryDoctorId: null,
    billingMode: "installments", baseCurrency: "YER", startDate: "2026-01-01", note: null,
    items: [], installments: [
      { dueDate: "2026-01-01", amountMinor: 5_000_000 },
      { dueDate: "2026-02-01", amountMinor: 5_000_000 },
    ],
    createdBy: "fin1",
  });
  expect(plan.ok).toBe(true);
  if (plan.ok) planId = plan.planId;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const collect = (key: string | null, amountMinor = 5_000_000, actor = "reception1") =>
  recordPlanInstallment({
    planId, patientId, installmentNumber: 1, planTitle: "تقويم ثابت",
    amountMinor, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    method: "cash", note: null, createdBy: actor, idempotencyKey: key,
  });

async function countsFor(key: string) {
  const { rows: [row] } = await getPool().query<{ payments: number; invoices: number }>(
    `SELECT (SELECT COUNT(*)::int FROM payments WHERE idempotency_key = $1) AS payments,
            (SELECT COUNT(*)::int FROM invoices i JOIN payments y ON y.invoice_id = i.id
              WHERE y.idempotency_key = $1) AS invoices`,
    [key],
  );
  return row;
}

async function planTotals() {
  const { rows: [row] } = await getPool().query<{ payments: number; invoices: number }>(
    `SELECT (SELECT COUNT(*)::int FROM payments WHERE plan_id = $1) AS payments,
            (SELECT COUNT(*)::int FROM invoices WHERE plan_id = $1) AS invoices`,
    [planId],
  );
  return row;
}

describe("(FIN-1) plan installment collection is idempotent", () => {
  it("a retry with the same key returns the first receipt — one invoice, one payment", async () => {
    const before = await planTotals();
    const first = await collect("inst:retry-0001");
    const again = await collect("inst:retry-0001");
    expect("paymentId" in first && "paymentId" in again).toBe(true);
    if (!("paymentId" in first) || !("paymentId" in again)) return;
    expect(again.paymentId).toBe(first.paymentId);
    expect(again.invoiceId).toBe(first.invoiceId);
    expect(again.replayed).toBe(true);
    expect(first.replayed).toBeFalsy();
    expect(await countsFor("inst:retry-0001")).toEqual({ payments: 1, invoices: 1 });
    const after = await planTotals();
    expect(after.payments - before.payments).toBe(1);
    expect(after.invoices - before.invoices).toBe(1);
  });

  it("five concurrent submissions with one key record a single receipt", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => collect("inst:burst-0001")));
    const ids = new Set(results.map((result) => ("paymentId" in result ? result.paymentId : null)));
    const counts = await countsFor("inst:burst-0001");
    expect(ids.size, JSON.stringify({ results, counts })).toBe(1);
    expect([...ids][0]).not.toBeNull();
    expect(counts).toEqual({ payments: 1, invoices: 1 });
  });

  it("five matching attempts replay a success committed after the pre-lock invoice snapshot", async () => {
    await collect("inst:snapshot-anchor"); // Keep evidence acquisition beyond its empty-invoice fast path.
    const key = "inst:snapshot-commit-window";
    const pool = getPool(); const paused = await pool.connect(); const realQuery = paused.query.bind(paused);
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    let observed!: () => void; let failed!: (error: unknown) => void;
    const sawSnapshot = new Promise<void>((resolve, reject) => { observed = resolve; failed = reject; });
    let intercepted = false;
    const querySpy = vi.spyOn(paused, "query").mockImplementation(async (sql, values) => {
      const result = await realQuery(sql, values);
      if (!intercepted && sql.includes("total_minor::text, discount_minor::text, base_currency")
        && sql.includes("FROM invoices WHERE patient_id = $1 ORDER BY id") && values?.[0] === patientId) {
        intercepted = true; observed(); await held;
      }
      return result;
    });
    const connectSpy = vi.spyOn(pool, "connect").mockResolvedValueOnce(paused);
    const retry = collect(key); void retry.catch(failed);
    try {
      await sawSnapshot;
      // Restore before released clients can be reused through Pool.query's callback overload.
      querySpy.mockRestore(); connectSpy.mockRestore();
      const winner = await collect(key);
      const others = await Promise.all(Array.from({ length: 3 }, () => collect(key)));
      release();
      const results = [winner, ...others, await retry];
      const counts = await countsFor(key);
      const { rows: [audit] } = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM audit_log a
        JOIN payments p ON a.entity = 'payment' AND a.entity_id = p.id::text
        WHERE p.idempotency_key = $1 AND a.action = 'payment.create'`, [key]);
      console.info("REPLAY_SNAPSHOT_WITNESS", JSON.stringify({ operation: "installment", results, counts, auditCount: audit.count }));
      const ids = new Set(results.map((result) => "paymentId" in result ? result.paymentId : null));
      expect(ids.size, JSON.stringify({ results, counts, auditCount: audit.count })).toBe(1);
      expect([...ids][0]).not.toBeNull(); expect(results.filter((result) => "replayed" in result && result.replayed)).toHaveLength(4);
      expect(counts).toEqual({ payments: 1, invoices: 1 }); expect(audit.count).toBe(1);
    } finally { release(); await retry.catch(() => {}); querySpy.mockRestore(); connectSpy.mockRestore(); }
  });

  it("the same key for a different amount or another actor is a conflict, not a replay", async () => {
    await collect("inst:conflict-01", 5_000_000);
    expect(await collect("inst:conflict-01", 4_000_000)).toEqual({ reason: "idempotency_conflict" });
    expect(await collect("inst:conflict-01", 5_000_000, "reception2")).toEqual({ reason: "idempotency_conflict" });
    expect(await countsFor("inst:conflict-01")).toEqual({ payments: 1, invoices: 1 });
  });

  it("a key already spent on an ordinary payment cannot be reused for an installment", async () => {
    const paid = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 100_000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "reception1",
      idempotencyKey: "shared:key-0001",
    });
    expect(paid.payment).not.toBeNull();
    expect(await collect("shared:key-0001")).toEqual({ reason: "idempotency_conflict" });
    expect((await countsFor("shared:key-0001")).payments).toBe(1);
  });

  it("without a key each call is its own collection (unchanged behaviour)", async () => {
    const before = await planTotals();
    await collect(null);
    await collect(null);
    const after = await planTotals();
    expect(after.payments - before.payments).toBe(2);
  });
});
