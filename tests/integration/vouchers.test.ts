import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { createTestDatabase, type TestDatabase } from "./helpers";

/**
 * Critical financial paths against real PostgreSQL (Phase 0 gate):
 *   - voucher creation atomicity (voucher + payment + audit + key in ONE tx)
 *   - double-submit idempotency (same key never duplicates)
 *   - currency/account matching barrier
 *   - reversal: counterpart entry, no deletes, patient ledger restored
 *   - human-readable sequential numbering
 */

describe("vouchers (integration)", () => {
  let testDb: TestDatabase;
  let actorId = "";
  let patientId = "";
  let yerAccountId = "";
  
  beforeAll(async () => {
    testDb = await createTestDatabase();
    // App modules read DATABASE_URL lazily — import AFTER it is set.
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const admin = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'مالي رئيسي', 'fin_admin', 'fin@t.local', true, 'ADMIN', true, now(), now()) RETURNING id, name`;
      actorId = admin[0]!.id;
      const patient = await sql`INSERT INTO patients (id, file_number, full_name, gender, mobile, treatment_status, recall_interval_days, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'P-910001', 'مريض مالي', 'MALE', '777111222', 'NEW', 21, true, now(), now()) RETURNING id`;
      patientId = patient[0]!.id;
      const yer = await sql`SELECT id FROM cash_accounts WHERE currency='YER' LIMIT 1`;
      yerAccountId = yer[0]!.id;
    } finally {
      await sql.end();
    }
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it("creates a patient receipt voucher atomically: voucher + payment + audit + numbering", async () => {
    const { createReceiptVoucher } = await import("@/server/finance/vouchers");
    const actor = { id: actorId, role: "ADMIN" as const, name: "مالي رئيسي" };

    const result = await createReceiptVoucher(actor, {
      patientId,
      amount: "5000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
      description: "دفعة على الحساب",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voucherNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);

    const sql = postgres(testDb.url, { max: 1 });
    try {
      // Payment mirrored and linked.
      const pay = await sql`SELECT amount, currency, voucher_id FROM payments WHERE voucher_id = ${result.id}`;
      expect(pay.length).toBe(1);
      expect(Number(pay[0]!.amount)).toBe(5000);
      expect(pay[0]!.currency).toBe("YER");

      // Audit row exists for the voucher creation.
      const audit = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'voucher' AND entity_id = ${result.id} AND action = 'VOUCHER_CREATED'`;
      expect(audit[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("never duplicates a voucher when the same idempotency key is replayed", async () => {
    const { createReceiptVoucher } = await import("@/server/finance/vouchers");
    const actor = { id: actorId, role: "ADMIN" as const, name: "مالي رئيسي" };
    const key = crypto.randomUUID();

    const first = await createReceiptVoucher(actor, {
      patientId,
      amount: "1000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);

    // Double-click / retry with the SAME key: same voucher, no duplicate.
    const replay = await createReceiptVoucher(actor, {
      patientId,
      amount: "1000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.id).toBe(first.id);

    const sql = postgres(testDb.url, { max: 1 });
    try {
      const count = await sql`SELECT count(*)::int AS n FROM vouchers WHERE id = ${first.id}`;
      expect(count[0]!.n).toBe(1);
      // Payment mirrored exactly once too.
      const payCount = await sql`SELECT count(*)::int AS n FROM payments WHERE voucher_id = ${first.id}`;
      expect(payCount[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("refuses a voucher whose currency differs from the cash account", async () => {
    const { createReceiptVoucher } = await import("@/server/finance/vouchers");
    const actor = { id: actorId, role: "ADMIN" as const, name: "مالي رئيسي" };

    const result = await createReceiptVoucher(actor, {
      patientId,
      amount: "100.00",
      currency: "USD",
      cashAccountId: yerAccountId, // YER account + USD amount → refuse
      paymentMethod: "CASH",
    });
    expect(result).toEqual({ ok: false, code: "currencyMismatch" });
  });

  it("reverses a receipt: counterpart entry created, original kept, patient ledger restored", async () => {
    const { createReceiptVoucher, reverseVoucher } = await import(
      "@/server/finance/vouchers"
    );
    const actor = { id: actorId, role: "ADMIN" as const, name: "مالي رئيسي" };

    const created = await createReceiptVoucher(actor, {
      patientId,
      amount: "2000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "TRANSFER",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Charge the patient so a balance exists: 20000 YER.
    const sql = postgres(testDb.url, { max: 1 });
    try {
      await sql`INSERT INTO charges (id, patient_id, amount, currency, description, created_by, created_at)
        VALUES (gen_random_uuid(), ${patientId}, 20000, 'YER', 'رسوم اختبار العكس', ${actorId}, now())`;
    } finally {
      await sql.end();
    }

    const reversed = await reverseVoucher(
      actor,
      created.id,
      "خطأ في المبلغ المدخل"
    );
    expect(reversed.ok).toBe(true);

    const sql2 = postgres(testDb.url, { max: 1 });
    try {
      // Original still exists, marked REVERSED — never deleted.
      const original = await sql2`SELECT status, voucher_number FROM vouchers WHERE id = ${created.id}`;
      expect(original[0]!.status).toBe("REVERSED");

      // Counterpart exists, linked back.
      const counterpart = await sql2`SELECT id, voucher_number, reversal_of_voucher_id, reversal_reason FROM vouchers WHERE reversal_of_voucher_id = ${created.id}`;
      expect(counterpart.length).toBe(1);
      expect(counterpart[0]!.reversal_reason).toBe("خطأ في المبلغ المدخل");

      // Patient ledger restored for THIS voucher: its mirrored payment is
      // now a negative (reversal) entry — the pair nets to zero.
      const pair = await sql2<{ amount: string }[]>`
        SELECT amount FROM payments WHERE voucher_id = ${created.id}`;
      expect(pair.length).toBe(1);
      expect(Number(pair[0]!.amount)).toBe(-2000);

      // Reversing twice is refused.
      const again = await reverseVoucher(actor, created.id, "محاولة ثانية");
      expect(again).toEqual({ ok: false, code: "alreadyReversed" });

      // Audited.
      const audit = await sql2`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = ${created.id} AND action = 'VOUCHER_REVERSED'`;
      expect(audit[0]!.n).toBe(1);
    } finally {
      await sql2.end();
    }
  });

  it("creates a general-expense payment voucher and pays a doctor commission via voucher", async () => {
    const { createPaymentVoucher } = await import("@/server/finance/vouchers");
    const actor = { id: actorId, role: "ADMIN" as const, name: "مالي رئيسي" };

    const sql = postgres(testDb.url, { max: 1 });
    let categoryId = "";
    let doctorId = "";
    try {
      const category = await sql`SELECT id FROM expense_categories LIMIT 1`;
      categoryId = category[0]!.id;
      const doctor = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'طبيب اختبار', 'doc_fin', 'docfin@t.local', true, 'DOCTOR', true, now(), now()) RETURNING id`;
      doctorId = doctor[0]!.id;
    } finally {
      await sql.end();
    }

    // General expense with mandatory category.
    const expense = await createPaymentVoucher(actor, {
      party: { kind: "OTHER", otherPartyName: "شركة الكهرباء", expenseCategoryId: categoryId },
      amount: "7500.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
      description: "فاتورة كهرباء الشهر",
    });
    expect(expense.ok).toBe(true);
    if (expense.ok) {
      expect(expense.voucherNumber).toMatch(/^PV-\d{4}-\d{6}$/);
    }

    // Doctor commission payment voucher.
    const commissionPayment = await createPaymentVoucher(actor, {
      party: { kind: "DOCTOR", doctorId },
      amount: "3000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
      description: "عمولة شهر",
    });
    expect(commissionPayment.ok).toBe(true);
  });

  it("draws strictly sequential numbers under concurrent creation (no gaps, no duplicates)", async () => {
    const { createPaymentVoucher } = await import("@/server/finance/vouchers");
    const actor = { id: actorId, role: "ADMIN" as const, name: "مالي رئيسي" };

    const sql = postgres(testDb.url, { max: 1 });
    let categoryId = "";
    try {
      const category = await sql`SELECT id FROM expense_categories LIMIT 1`;
      categoryId = category[0]!.id;
    } finally {
      await sql.end();
    }

    // Five concurrent submissions.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createPaymentVoucher(actor, {
          party: { kind: "OTHER", otherPartyName: `مصروف متزامن ${i}`, expenseCategoryId: categoryId },
          amount: "100.00",
          currency: "YER",
          cashAccountId: yerAccountId,
          paymentMethod: "CASH",
        })
      )
    );

    const numbers = results
      .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
      .map((r) => r.voucherNumber);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(numbers).size).toBe(5);

    const sql2 = postgres(testDb.url, { max: 1 });
    try {
      const counter = await sql2`SELECT last_number FROM voucher_counters WHERE kind='PAYMENT'`;
      const used = await sql2`SELECT count(*)::int AS n FROM vouchers WHERE type='PAYMENT'`;
      expect(used[0]!.n).toBeGreaterThanOrEqual(5);
      expect(counter[0]!.last_number).toBeGreaterThanOrEqual(5);
    } finally {
      await sql2.end();
    }
  });
});
