import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import {
  createTestDatabase,
  readPgUrl,
  type TestDatabase,
} from "./helpers";

/**
 * Acceptance: migrations must apply on an EMPTY database and on a copy of
 * the PREVIOUS schema with live data — without losing a single row.
 */

describe("migrations", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it("applies all migrations to an empty database", () => {
    // createTestDatabase already applied every migration — verify the
    // expected tables exist with their constraints.
    expect(true).toBe(true);
  });

  it("creates all new tables, enums and constraints", async () => {
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`;
      const names = tables.map((row) => row.table_name);

      for (const expected of [
        "service_categories",
        "services",
        "visit_work_items",
        "visit_corrections",
        "idempotency_keys",
        "cash_accounts",
        "expense_categories",
        "voucher_counters",
        "vouchers",
        "doctor_commission_plans",
        "commissions",
        "labs",
        "lab_cases",
        "suppliers",
        "materials",
        "purchase_invoices",
        "purchase_invoice_items",
      ]) {
        expect(names).toContain(expected);
      }

      const indexes = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
      const indexNames = indexes.map((row) => row.indexname);
      expect(indexNames).toContain("vouchers_number_unique");
      expect(indexNames).toContain("vouchers_reversal_target_unique");
      expect(indexNames).toContain("vouchers_active_commission_payment_unique");
      expect(indexNames).toContain("visits_appointment_unique");
      expect(indexNames).toContain("commissions_work_item_unique");
      expect(indexNames).toContain("commissions_collected_unique");
      expect(indexNames).toContain("doctor_commission_plans_doctor_service_unique");
    } finally {
      await sql.end();
    }
  });

  it("seeds editable service categories, expense categories and default cash accounts", async () => {
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const categories = await sql`SELECT count(*)::int AS n FROM service_categories`;
      expect(categories[0]!.n).toBeGreaterThanOrEqual(14);

      const expenses = await sql`SELECT count(*)::int AS n FROM expense_categories`;
      expect(expenses[0]!.n).toBeGreaterThanOrEqual(10);

      const accounts = await sql<{ currency: string }[]>`
        SELECT currency FROM cash_accounts ORDER BY currency`;
      expect(accounts.map((a) => a.currency).sort()).toEqual(["SAR", "USD", "YER"]);
    } finally {
      await sql.end();
    }
  });

  it("rejects a second visit for the same appointment (partial unique index)", async () => {
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const user = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'Doc', 'doc_t1', 'doc@t.local', true, 'DOCTOR', true, now(), now()) RETURNING id`;
      const patient = await sql`INSERT INTO patients (id, file_number, full_name, gender, mobile, treatment_status, recall_interval_days, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'P-900001', 'مريض اختبار', 'MALE', '777000111', 'NEW', 21, true, now(), now()) RETURNING id`;
      const appointment = await sql`INSERT INTO appointments (id, patient_id, doctor_id, appointment_date, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${patient[0]!.id}, ${user[0]!.id}, now(), 'SCHEDULED', ${user[0]!.id}, now(), now()) RETURNING id`;

      await sql`INSERT INTO visits (id, patient_id, doctor_id, appointment_id, visit_date, treatment_performed, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${patient[0]!.id}, ${user[0]!.id}, ${appointment[0]!.id}, now(), 'أول زيارة', 'DRAFT', ${user[0]!.id}, now(), now())`;

      await expect(
        sql`INSERT INTO visits (id, patient_id, doctor_id, appointment_id, visit_date, treatment_performed, status, created_by, created_at, updated_at)
          VALUES (gen_random_uuid(), ${patient[0]!.id}, ${user[0]!.id}, ${appointment[0]!.id}, now(), 'زيارة ثانية مكررة', 'DRAFT', ${user[0]!.id}, now(), now())`
      ).rejects.toThrow(/visits_appointment_unique/);
    } finally {
      await sql.end();
    }
  });

  it("rejects non-positive voucher amounts and mismatched parties (check constraints)", async () => {
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const user = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'Admin', 'admin_t2', 'admin@t.local', true, 'ADMIN', true, now(), now()) RETURNING id`;
      const account = await sql`SELECT id FROM cash_accounts WHERE currency = 'YER' LIMIT 1`;

      // Negative amount must fail.
      await expect(
        sql`INSERT INTO vouchers (type, voucher_number, party_type, amount, currency, cash_account_id, payment_method, voucher_date, created_by, created_at, updated_at)
          VALUES ('RECEIPT', 'RCPT-2026-000099', 'PATIENT', -100, 'YER', ${account[0]!.id}, 'CASH', now(), ${user[0]!.id}, now(), now())`
      ).rejects.toThrow();

      // A receipt without patient or other-party name must fail.
      await expect(
        sql`INSERT INTO vouchers (type, voucher_number, party_type, amount, currency, cash_account_id, payment_method, voucher_date, created_by, created_at, updated_at)
          VALUES ('RECEIPT', 'RCPT-2026-000098', 'PATIENT', 100, 'YER', ${account[0]!.id}, 'CASH', now(), ${user[0]!.id}, now(), now())`
      ).rejects.toThrow(/vouchers_receipt_party/);
    } finally {
      await sql.end();
    }
  });

  it("upgrades the PREVIOUS schema with live data and loses nothing (backfill safety)", async () => {
    // Build a database at the pre-expansion state (migrations 0000-0005),
    // insert live clinical/financial rows, then apply the new migration.
    const adminUrl = readPgUrl();
    const admin = postgres(adminUrl, { max: 1 });
    const dbName = "t_upgrade_" + Math.random().toString(36).slice(2, 8);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const dbUrl = adminUrl.replace(/\/[^/]+$/, `/${dbName}`);

    const oldSql = postgres(dbUrl, { max: 1 });
    try {
      // Apply everything EXCEPT the new 0006 migration.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const drizzleDir = path.resolve(import.meta.dirname, "../../drizzle");
      const files = fs
        .readdirSync(drizzleDir)
        .filter((f) => f.endsWith(".sql") && f < "0006")
        .sort();
      expect(files.length).toBe(6); // 0000..0005
      for (const file of files) {
        const raw = fs.readFileSync(path.join(drizzleDir, file), "utf8");
        for (const statement of raw
          .split("--> statement-breakpoint")
          .map((s: string) => s.trim())
          .filter(Boolean)) {
          await oldSql.unsafe(statement);
        }
      }

      // Live data at the old schema state.
      const user = await oldSql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'Legacy Admin', 'legacy_t3', 'legacy@t.local', true, 'ADMIN', true, now(), now()) RETURNING id`;
      const patient = await oldSql`INSERT INTO patients (id, file_number, full_name, gender, mobile, treatment_status, recall_interval_days, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'P-900100', 'مريض قديم', 'FEMALE', '777000222', 'ACTIVE', 21, true, now(), now()) RETURNING id`;
      await oldSql`INSERT INTO charges (id, patient_id, amount, currency, description, created_by, created_at)
        VALUES (gen_random_uuid(), ${patient[0]!.id}, 30000, 'YER', 'تقويم كامل', ${user[0]!.id}, now())`;
      await oldSql`INSERT INTO payments (id, patient_id, amount, currency, description, created_by, created_at)
        VALUES (gen_random_uuid(), ${patient[0]!.id}, 12000, 'YER', 'دفعة أولى', ${user[0]!.id}, now())`;
      await oldSql`INSERT INTO payments (id, patient_id, amount, currency, description, created_by, created_at)
        VALUES (gen_random_uuid(), ${patient[0]!.id}, 50, 'USD', 'دفعة دولار', ${user[0]!.id}, now())`;
      const appointment = await oldSql`INSERT INTO appointments (id, patient_id, doctor_id, appointment_date, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${patient[0]!.id}, ${user[0]!.id}, now(), 'COMPLETED', ${user[0]!.id}, now(), now()) RETURNING id`;
      await oldSql`INSERT INTO visits (id, patient_id, doctor_id, appointment_id, visit_date, treatment_performed, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${patient[0]!.id}, ${user[0]!.id}, ${appointment[0]!.id}, now(), 'تركيب تقويم', 'COMPLETED', ${user[0]!.id}, now(), now())`;

      // Now apply every remaining forward migration (0006 and later). This
      // models production, where 0006 may already exist before 0007 arrives.
      const fsMod = await import("node:fs");
      const pathMod = await import("node:path");
      const forwardFiles = fsMod
        .readdirSync(drizzleDir)
        .filter((file) => file.endsWith(".sql") && file >= "0006")
        .sort();
      expect(forwardFiles).toContain("0006_finance_operations_expansion.sql");
      expect(forwardFiles).toContain("0007_finance_reversal_invariants.sql");
      for (const file of forwardFiles) {
        const raw = fsMod.readFileSync(pathMod.join(drizzleDir, file), "utf8");
        for (const statement of raw
          .split("--> statement-breakpoint")
          .map((s: string) => s.trim())
          .filter(Boolean)) {
          await oldSql.unsafe(statement);
        }
      }

      // Nothing lost: charges, payments, visits all intact.
      const charges = await oldSql`SELECT count(*)::int AS n FROM charges`;
      const payments = await oldSql`SELECT count(*)::int AS n FROM payments`;
      const visits = await oldSql`SELECT count(*)::int AS n FROM visits`;
      expect(charges[0]!.n).toBe(1);
      expect(payments[0]!.n).toBe(2);
      expect(visits[0]!.n).toBe(1);

      // Legacy payments keep voucher_id NULL (pre-treasury history) and the
      // patient balance is unchanged: 30000 - 12000 = 18000 YER, 50 USD credit.
      const chargeTotals = await oldSql<{ currency: string; total: string }[]>`
        SELECT currency, COALESCE(SUM(amount), 0) AS total
        FROM charges WHERE patient_id = ${patient[0]!.id} GROUP BY currency`;
      const paymentTotals = await oldSql<{ currency: string; total: string }[]>`
        SELECT currency, COALESCE(SUM(amount), 0) AS total
        FROM payments WHERE patient_id = ${patient[0]!.id} GROUP BY currency`;
      const yerCharge = Number(chargeTotals.find((r) => r.currency === "YER")?.total);
      const yerPaid = Number(paymentTotals.find((r) => r.currency === "YER")?.total);
      expect(yerCharge - yerPaid).toBe(18000);
      const usdPaid = Number(paymentTotals.find((r) => r.currency === "USD")?.total);
      expect(usdPaid).toBe(50);

      // The legacy visit's appointment link survived the dedupe step.
      const linked = await oldSql`SELECT appointment_id FROM visits`;
      expect(linked[0]!.appointment_id).toBe(appointment[0]!.id);
    } finally {
      await oldSql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
  });
});
