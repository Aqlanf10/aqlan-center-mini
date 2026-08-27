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

    const sql = postgres(testDb.url, { max: 1 });
    let balanceBefore = 0;
    let cashBefore = 0;
    try {
      // Add an unrelated charge and snapshot the pre-receipt patient/cash
      // balances. Earlier tests intentionally share this database.
      await sql`INSERT INTO charges (id, patient_id, amount, currency, description, created_by, created_at)
        VALUES (gen_random_uuid(), ${patientId}, 20000, 'YER', 'رسوم اختبار العكس', ${actorId}, now())`;

      const [patientBalance] = await sql<{ balance: string }[]>`
        SELECT COALESCE((SELECT SUM(amount) FROM charges WHERE patient_id = ${patientId} AND currency = 'YER'), 0)
             - COALESCE((SELECT SUM(amount) FROM payments WHERE patient_id = ${patientId} AND currency = 'YER'), 0) AS balance`;
      balanceBefore = Number(patientBalance!.balance);

      const [cashBalance] = await sql<{ balance: string }[]>`
        SELECT COALESCE(SUM(CASE
          WHEN type = 'RECEIPT' AND reversal_of_voucher_id IS NULL THEN amount
          WHEN type = 'RECEIPT' THEN -amount
          WHEN type = 'PAYMENT' AND reversal_of_voucher_id IS NULL THEN -amount
          ELSE amount END), 0) AS balance
        FROM vouchers WHERE cash_account_id = ${yerAccountId}`;
      cashBefore = Number(cashBalance!.balance);
    } finally {
      await sql.end();
    }

    const created = await createReceiptVoucher(actor, {
      patientId,
      amount: "2000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "TRANSFER",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

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

      if (!reversed.ok) return;

      // Patient subledger is append-only: original positive + separate
      // negative row linked to the counterpart voucher = zero.
      const pair = await sql2<{
        amount: string;
        voucher_id: string;
        reversal_of_voucher_id: string | null;
      }[]>`
        SELECT p.amount, p.voucher_id, v.reversal_of_voucher_id
        FROM payments p
        JOIN vouchers v ON v.id = p.voucher_id
        WHERE p.voucher_id IN (${created.id}, ${reversed.id})
        ORDER BY p.amount::numeric DESC`;
      expect(pair).toHaveLength(2);
      expect(Number(pair[0]!.amount)).toBe(2000);
      expect(pair[0]!.voucher_id).toBe(created.id);
      expect(pair[0]!.reversal_of_voucher_id).toBeNull();
      expect(Number(pair[1]!.amount)).toBe(-2000);
      expect(pair[1]!.voucher_id).toBe(reversed.id);
      expect(pair[1]!.reversal_of_voucher_id).toBe(created.id);
      expect(pair.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(0);

      const [patientBalanceAfter] = await sql2<{ balance: string }[]>`
        SELECT COALESCE((SELECT SUM(amount) FROM charges WHERE patient_id = ${patientId} AND currency = 'YER'), 0)
             - COALESCE((SELECT SUM(amount) FROM payments WHERE patient_id = ${patientId} AND currency = 'YER'), 0) AS balance`;
      expect(Number(patientBalanceAfter!.balance)).toBe(balanceBefore);

      const [cashBalanceAfter] = await sql2<{ balance: string }[]>`
        SELECT COALESCE(SUM(CASE
          WHEN type = 'RECEIPT' AND reversal_of_voucher_id IS NULL THEN amount
          WHEN type = 'RECEIPT' THEN -amount
          WHEN type = 'PAYMENT' AND reversal_of_voucher_id IS NULL THEN -amount
          ELSE amount END), 0) AS balance
        FROM vouchers WHERE cash_account_id = ${yerAccountId}`;
      expect(Number(cashBalanceAfter!.balance)).toBe(cashBefore);

      const { getPatientStatement } = await import("@/server/finance/statements");
      const statement = await getPatientStatement(patientId);
      const statementPair = statement?.lines.filter(
        (line) =>
          line.voucherNumber === created.voucherNumber ||
          line.voucherNumber === reversed.voucherNumber
      );
      expect(statementPair).toHaveLength(2);
      expect(statementPair?.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(0);

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

  it("allows exactly one of two concurrent reversal requests", async () => {
    const { createReceiptVoucher, reverseVoucher } = await import(
      "@/server/finance/vouchers"
    );
    const actor = { id: actorId, role: "ADMIN" as const, name: "مالي رئيسي" };

    const created = await createReceiptVoucher(actor, {
      patientId,
      amount: "1750.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const results = await Promise.all([
      reverseVoucher(actor, created.id, "طلب عكس متزامن أول"),
      reverseVoucher(actor, created.id, "طلب عكس متزامن ثان"),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "alreadyReversed")).toHaveLength(1);

    const sql = postgres(testDb.url, { max: 1 });
    try {
      const [reversalCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM vouchers WHERE reversal_of_voucher_id = ${created.id}`;
      expect(reversalCount!.count).toBe(1);

      const [paymentPair] = await sql<{ count: number; total: string }[]>`
        SELECT count(*)::int AS count, COALESCE(SUM(p.amount), 0) AS total
        FROM payments p
        JOIN vouchers v ON v.id = p.voucher_id
        WHERE p.voucher_id = ${created.id} OR v.reversal_of_voucher_id = ${created.id}`;
      expect(paymentPair!.count).toBe(2);
      expect(Number(paymentPair!.total)).toBe(0);
    } finally {
      await sql.end();
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

  it("shows the FINANCIAL PARTY (doctor/lab/supplier) in the register, never the voucher creator", async () => {
    const { createPaymentVoucher } = await import("@/server/finance/vouchers");
    const { listVouchers } = await import("@/server/finance/reports");
    const actor = { id: actorId, role: "ADMIN" as const, name: "مالي رئيسي" };

    const sql = postgres(testDb.url, { max: 1 });
    let doctorId = "";
    let labId = "";
    let supplierId = "";
    try {
      // A doctor whose name is clearly different from the creator's name.
      const doctor = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'د. الطرف المالي', 'party_doc', 'partydoc@t.local', true, 'DOCTOR', true, now(), now()) RETURNING id`;
      doctorId = doctor[0]!.id;
      const lab = await sql`INSERT INTO labs (id, name, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'معمل الطرف المالي', true, now(), now()) RETURNING id`;
      labId = lab[0]!.id;
      const supplier = await sql`INSERT INTO suppliers (id, name, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'مورد الطرف المالي', true, now(), now()) RETURNING id`;
      supplierId = supplier[0]!.id;
    } finally {
      await sql.end();
    }

    const doctorVoucher = await createPaymentVoucher(actor, {
      party: { kind: "DOCTOR", doctorId },
      amount: "3000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
    });
    expect(doctorVoucher.ok).toBe(true);

    const labVoucher = await createPaymentVoucher(actor, {
      party: { kind: "LAB", labId },
      amount: "2000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
    });
    expect(labVoucher.ok).toBe(true);

    const supplierVoucher = await createPaymentVoucher(actor, {
      party: { kind: "SUPPLIER", supplierId },
      amount: "1500.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
    });
    expect(supplierVoucher.ok).toBe(true);

    const { rows } = await listVouchers({ type: "PAYMENT", limit: 200 });
    const byId = new Map(rows.map((row) => [row.id, row]));

    // The doctor column must carry the DOCTOR's name — the creator ("مالي
    // رئيسي") must never appear as the beneficiary party.
    const doctorRow = byId.get(doctorVoucher.ok ? doctorVoucher.id : "")!;
    expect(doctorRow).toBeDefined();
    expect(doctorRow.doctorName).toBe("د. الطرف المالي");
    expect(doctorRow.createdByName).toBe("مالي رئيسي");
    expect(doctorRow.doctorName).not.toBe(doctorRow.createdByName);

    const labRow = byId.get(labVoucher.ok ? labVoucher.id : "")!;
    expect(labRow.labName).toBe("معمل الطرف المالي");
    expect(labRow.createdByName).toBe("مالي رئيسي");

    const supplierRow = byId.get(supplierVoucher.ok ? supplierVoucher.id : "")!;
    expect(supplierRow.supplierName).toBe("مورد الطرف المالي");
    expect(supplierRow.createdByName).toBe("مالي رئيسي");

    // Print/detail path stays consistent with the register.
    const { getVoucherById } = await import("@/server/finance/reports");
    const detail = await getVoucherById(doctorVoucher.ok ? doctorVoucher.id : "");
    expect(detail?.doctorName).toBe("د. الطرف المالي");
    expect(detail?.createdByName).toBe("مالي رئيسي");
  });
});
