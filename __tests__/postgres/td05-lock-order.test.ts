import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (TD-05 PR #44 — المراجعة الثانية للمالك، الاستنتاج ٩) ترتيب الأقفال المالي
 * الكانوني على PostgreSQL حقيقي.
 *
 * كان recordPayment يقفل: فاتورة/خطة → ثم الوردية،
 * وrecordPlanInstallment يقفل: الوردية → ثم الخطة — ترتيبان متعاكسان على
 * الصفين أنفسهما = دورة AB-BA مات بها: إحدى المعاملتين تُقتل بdeadlock (40P01).
 *
 * العلاج: ترتيب كانوني واحد في كل المعاملات المالية:
 *   payments(أصل الردّ) → cashier_shifts → invoices → treatment_plans → plan_items
 *
 * الاختبارات هنا تبني التزاحم نفسه الذي كان يميت الإنتاج (بوابة قفلٍ تحبس
 * المعاملة الأولى عند الوردية حتى تقف الثانية على الخطة) — فتفشل على الكود
 * القديم بdeadlock حقيقي، وتنجح بعد التوحيد.
 *
 * ملاحظة تشغيلية (PG18): استقصاء pg_stat_activity يجري عبر اتصال «شاهد»
 * مستقل بوضع autocommit — المعاملة المفتوحة على بوابة القفل لا ترى الاتصالات
 * التي وُلدت بعدها، فلو استُقصي منها لَما ظهر المنتظر الثاني أبدًا.
 *
 * انضباط البوابة: مهما فشل المسعى تُرخّى البوابة حتمًا في finally (COMMIT إن
 * نجح المسار، ROLLBACK غير ذلك) — فلا تبقى معاملةً مفتوحة تحبس من بعدها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, closeShift,
  recordPayment, recordPlanInstallment, createPlanV2,
} = await import("../../lib/db");

let patientId: number;
let usdPlanId: number;
let gate: Client;
let witness: Client;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "lock-order", opening: { YER: 0, SAR: 0, USD: 0 } });
  const pool = getPool();
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('LOCK-1', 'مريض ترتيب الأقفال') RETURNING id`,
  );
  patientId = patient.id;
  const { rows: [service] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active) VALUES ('تنظيف ترتيب الأقفال', 15000, TRUE) RETURNING id`,
  );
  const serviceId = service.id;

  const plan = await createPlanV2({
    patientId, title: "اتفاق دولاري لترتيب الأقفال", specialty: null, primaryDoctorId: null,
    billingMode: "per_procedure", baseCurrency: "USD", startDate: "2026-01-01", note: null,
    items: [{
      serviceId, serviceName: "تنظيف ترتيب الأقفال", category: "cleaning", toothCode: null, surfaces: null,
      quantity: 1, unitPriceMinor: 200000, billingRule: "on_completion", sessionCount: 1, note: null,
    }],
    installments: [], createdBy: "lock-order",
  });
  expect(plan.ok).toBe(true);
  if (plan.ok) usdPlanId = plan.planId;

  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('finance.rate.USD', '530')`,
  );

  /* البوابة تقفل صف الوردية؛ والشاهد — اتصال autocommit مستقل — هو الذي يستقصي
     النشاط: رؤيته كاملة دائمًا بخلاف رؤية معاملة البوابة المفتوحة. */
  gate = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  await gate.connect();
  witness = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  await witness.connect();
}, 180_000);

afterAll(async () => {
  await gate?.query("ROLLBACK").catch(() => {});
  await gate?.end().catch(() => {});
  await witness?.end().catch(() => {});
  await resetPoolForTesting();
});

/** عدد الاتصالات المنتظرة على قفلٍ واستعلامها الجاري يطابق النمط — عبر الشاهد. */
async function lockWaitersMatching(pattern: string): Promise<number> {
  const { rows: [row] } = await witness.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ~ $1`,
    [pattern],
  );
  return row.n;
}

/** يدور حتى يصبح عدد المنتظرين على النمط العددَ المطلوب — أو يفشل بمهلة. */
async function untilWaiters(pattern: string, count: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await lockWaitersMatching(pattern) === count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `لم يصل عدد المنتظرين على قفل «${pattern}» إلى ${count} خلال ${timeoutMs}ms — ` +
    `الواقع: ${await lockWaitersMatching(pattern)}`,
  );
}

/** كل النتائج «فُعِلت» — لا رفض ولا قتل deadlock — والرسالة معها للتشخيص. */
async function settled<T>(promise: Promise<T>): Promise<{ ok: boolean; error?: string }> {
  try {
    await promise;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function deadlockError(result: { ok: boolean; error?: string }): boolean {
  return /deadlock|40P01/i.test(result.error ?? "");
}

function advancePayment(amountMinor: number) {
  return recordPayment({
    patientId, invoiceId: null, planId: usdPlanId, kind: "payment" as const,
    amountMinor, currency: "USD" as const, baseCurrency: "YER" as const, exchangeRate: 530,
    method: "cash", note: "دفعة مقدَّمة على الخطة — ترتيب الأقفال", createdBy: "lock-order",
  });
}

function installmentCollection(amountMinor: number) {
  return recordPlanInstallment({
    planId: usdPlanId, patientId, installmentNumber: (Date.now() % 1000) + 1,
    planTitle: "اتفاق دولاري لترتيب الأقفال", amountMinor, currency: "USD" as const,
    baseCurrency: "YER" as const, exchangeRate: 530, method: "cash",
    note: "تحصيل قسط — ترتيب الأقفال", createdBy: "lock-order",
  });
}

/** بوابة الوردية: تقفل الصف ثم تُدير المسعى، وتُرخّى القفل حتمًا في finally. */
async function withShiftGate(run: (commit: () => Promise<void>) => Promise<void>): Promise<void> {
  await gate.query("BEGIN");
  await gate.query(`SELECT id FROM cashier_shifts WHERE status = 'open' FOR UPDATE`);
  let committed = false;
  try {
    await run(async () => {
      await gate.query("COMMIT");
      committed = true;
    });
  } finally {
    if (!committed) await gate.query("ROLLBACK").catch(() => {});
  }
}

/* ═══════════ ١) قسط الخطة + دفعة مقدَّمة عليها معًا ═══════════ */

describe("ترتيب الأقفال ٩-١: تحصيل قسطٍ ودفعةٍ مقدَّمة على الخطة نفسها متزامنين", () => {
  it("بوابة الوردية تُسلسلهما بلا deadlock — كلاهما ينجح ولا شيء يضيع", async () => {
    await withShiftGate(async (commit) => {
      /* القسط يبدأ أولًا فيقف منتظرًا الوردية (قبل أن يلمس الخطة). */
      const installmentPromise = settled(installmentCollection(60000));
      await untilWaiters("cashier_shifts", 1);

      /* الدفعة المقدَّمة تبدأ فتقفل الخطة ثم تنتظر الوردية — هذا التقاطع بعينه. */
      const advancePromise = settled(advancePayment(30000));
      await untilWaiters("cashier_shifts", 2);

      /* فتح البوابة: من هنا إما التسلسل الكانوني النظيف، أو deadlock الكود القديم. */
      await commit();

      const [installment, advance] = await Promise.all([installmentPromise, advancePromise]);
      expect(installment.ok).toBe(true);
      expect(advance.ok).toBe(true);
      expect(deadlockError(installment)).toBe(false);
      expect(deadlockError(advance)).toBe(false);
    });

    /* لا ضياع: كلا السندين موجود بالقاعدة بدلو الدولار وبورديةٍ مفتوحة. */
    const { rows: payments } = await getPool().query<{ currency: string; shift_status: string }>(
      `SELECT p.currency, s.status AS shift_status
         FROM payments p JOIN cashier_shifts s ON s.id = p.shift_id
        WHERE p.patient_id = $1 AND p.plan_id = $2 AND p.reversal_of_id IS NULL`,
      [patientId, usdPlanId],
    );
    const planPayments = payments.filter((row) => row.currency === "USD");
    expect(planPayments.length).toBeGreaterThanOrEqual(2);
    for (const row of planPayments) {
      expect(row.shift_status).toBe("open"); /* لا سند خارج وردية مفتوحة */
    }
  }, 120_000);
});

/* ═══════════ ٢) دفعتان مقدَّمتان على الخطة نفسها معًا ═══════════ */

describe("ترتيب الأقفال ٩-٢: دفعتان مقدَّمتان متزامنتان على الخطة نفسها", () => {
  it("كلاهما تسجَّل — لا deadlock ولا ضياع ولا ازدواج", async () => {
    const [a, b] = await Promise.all([advancePayment(11000), advancePayment(12000)]);
    expect(a.reason).toBeNull();
    expect(b.reason).toBeNull();
    expect(a.payment!.id).not.toBe(b.payment!.id);

    const { rows: [row] } = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1 AND plan_id = $2
         AND kind = 'payment' AND amount_minor = ANY($3::bigint[])`,
      [patientId, usdPlanId, [11000, 12000]],
    );
    expect(row.n).toBe(2);
  }, 120_000);
});

/* ═══════════ ٣) دفعة مع إغلاق الوردية ═══════════ */

describe("ترتيب الأقفال ٩-٣: دفعة متزامنة مع إغلاق الوردية", () => {
  it("لا deadlock ولا دفعة بلا وردية — وإعادة فتح الوردية بعدها", async () => {
    const { rows: [openRow] } = await getPool().query<{ id: number }>(
      `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
    );

    const paymentPromise = settled(advancePayment(7000));
    const closePromise = settled(
      closeShift({ id: openRow.id, closedBy: "lock-order", counted: { YER: 0, SAR: 0, USD: 0 }, note: null, differenceReason: "إقفال اختبار" }),
    );

    const [payment, close] = await Promise.all([paymentPromise, closePromise]);
    expect(payment.ok).toBe(true);
    expect(close.ok).toBe(true);
    expect(deadlockError(payment)).toBe(false);
    expect(deadlockError(close)).toBe(false);

    /* أُعيد فتح الوردية لبقية الرحلة. */
    await openShift({ openedBy: "lock-order", opening: { YER: 0, SAR: 0, USD: 0 } });

    /* لا سند بلا وردية أبدًا: كل سندٍ قُيِد مرتبطٌ بصف وردية قائم. */
    const { rows: [orphan] } = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payments p LEFT JOIN cashier_shifts s ON s.id = p.shift_id
        WHERE p.id IS NOT NULL AND s.id IS NULL`,
    );
    expect(orphan.n).toBe(0);
  }, 120_000);
});

/* ═══════════ ٤) ردُّ سند خطة مع تحصيل قسطٍ على الخطتها ═══════════ */

describe("ترتيب الأقفال ٩-٤: ردُّ دفعة الخطة متزامنًا مع تحصيل قسطٍ عليها", () => {
  it("بوابة الوردية تُسلسل الردّ والقسط — كلاهما ينجح بلا deadlock", async () => {
    const { rows: [origin] } = await getPool().query<{ id: number }>(
      `SELECT id FROM payments WHERE plan_id = $1 AND kind = 'payment' ORDER BY id LIMIT 1`,
      [usdPlanId],
    );
    expect(origin).toBeTruthy();

    await withShiftGate(async (commit) => {
      /* القسط أولًا: ينتظر عند الوردية قبل أن يلمس الخطة. */
      const installmentPromise = settled(installmentCollection(25000));
      await untilWaiters("cashier_shifts", 1);

      /* الردّ يبدأ: يقفل سند الأصل ثم يقفل الخطة (وراثة الهدف) ثم ينتظر الوردية. */
      const refundPromise = settled(recordPayment({
        patientId, invoiceId: null, planId: null, kind: "refund" as const,
        amountMinor: 5000, currency: "USD" as const, baseCurrency: "YER" as const, exchangeRate: 530,
        method: "cash", note: "رد متزامن مع قسط", createdBy: "lock-order",
        reversalOfId: origin.id,
      }));
      await untilWaiters("cashier_shifts", 2);

      await commit();

      const [installment, refund] = await Promise.all([installmentPromise, refundPromise]);
      expect(installment.ok).toBe(true);
      expect(refund.ok).toBe(true);
      expect(deadlockError(installment)).toBe(false);
      expect(deadlockError(refund)).toBe(false);
    });
  }, 120_000);
});

/* ═══════════ عقد الترتيب الكانوني موثَّقًا بالفحص ═══════════ */

describe("عقد ترتيب الأقفال الكانوني: القاعدة خالية من آثار القتل", () => {
  it("كل سنود الاختبار في ورديةٍ، وكلها دولارية بقيمها الصحيحة", async () => {
    const { rows } = await getPool().query<{ currency: string; base_amount_minor: string; shift_status: string }>(
      `SELECT p.currency, p.base_amount_minor, s.status AS shift_status
         FROM payments p JOIN cashier_shifts s ON s.id = p.shift_id
        WHERE p.patient_id = $1`,
      [patientId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.currency).toBe("USD");          /* الدلو الصحيح لا غير */
      expect(Number(row.base_amount_minor)).toBeGreaterThan(0);
      expect(["open", "closed"]).toContain(row.shift_status); /* لا سند بلا وردية */
    }
  });
});
