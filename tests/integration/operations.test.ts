import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { createTestDatabase, type TestDatabase } from "./helpers";

/**
 * Acceptance-critical flows against real PostgreSQL:
 *   1. Two work items in one visit → daily work report rows.
 *   2. Commission generated ONCE with plan snapshot → approve → pay via
 *      payment voucher → reversal refuses double generation.
 *   3. Lab case → invoice → partial payment → remaining visible.
 *   4. Supplier multi-line invoice → partial payment → balance.
 *   5. Completed visit immutability (work items locked, corrections append).
 */

describe("daily operations & finance (integration)", () => {
  let testDb: TestDatabase;
  let adminId = "";
  let doctorId = "";
  let patientId = "";
  let serviceAId = "";
  let serviceBId = "";

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const sql = postgres(testDb.url, { max: 1 });
    try {
      const admin = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'مدير', 'ops_admin', 'ops@t.local', true, 'ADMIN', true, now(), now()) RETURNING id`;
      adminId = admin[0]!.id;
      const doctor = await sql`INSERT INTO users (id, name, username, email, email_verified, role, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'طبيب العمليات', 'ops_doc', 'opsdoc@t.local', true, 'DOCTOR', true, now(), now()) RETURNING id`;
      doctorId = doctor[0]!.id;
      const patient = await sql`INSERT INTO patients (id, file_number, full_name, gender, mobile, treatment_status, recall_interval_days, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'P-920001', 'مريض العمليات', 'MALE', '777222333', 'NEW', 21, true, now(), now()) RETURNING id`;
      patientId = patient[0]!.id;

      // Two services: one commission-eligible, one not.
      const serviceA = await sql`INSERT INTO services (id, code, name_ar, name_en, default_price, currency, commission_eligible, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'SRV-A', 'تقويم', 'Ortho', 15000, 'YER', true, true, now(), now()) RETURNING id`;
      serviceAId = serviceA[0]!.id;
      const serviceB = await sql`INSERT INTO services (id, code, name_ar, name_en, default_price, currency, commission_eligible, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'SRV-B', 'تنظيف', 'Cleaning', 5000, 'YER', false, true, now(), now()) RETURNING id`;
      serviceBId = serviceB[0]!.id;
    } finally {
      await sql.end();
    }
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it("records two work items in one visit and completes it (commissions generated)", async () => {
    const { addWorkItem } = await import("@/server/services/work-items");
    const actor = { id: adminId, role: "ADMIN" as const, name: "مدير" };

    const sql = postgres(testDb.url, { max: 1 });
    let visitId = "";
    try {
      const visit = await sql`INSERT INTO visits (id, patient_id, doctor_id, visit_date, treatment_performed, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${patientId}, ${doctorId}, now(), 'تركيب وتنظيف', 'DRAFT', ${adminId}, now(), now()) RETURNING id`;
      visitId = visit[0]!.id;
    } finally {
      await sql.end();
    }

    const first = await addWorkItem(actor, visitId, {
      serviceId: serviceAId,
      doctorId,
      quantity: "1",
      unitPrice: "15000.00",
      discount: "1000.00",
      currency: "YER",
      notes: null,
    });
    expect(first.ok).toBe(true);

    const second = await addWorkItem(actor, visitId, {
      serviceId: serviceBId,
      doctorId,
      quantity: "2",
      unitPrice: "5000.00",
      discount: null,
      currency: "YER",
      notes: null,
    });
    expect(second.ok).toBe(true);

    // Complete the visit via the module path that generates commissions.
    const { generateCommissionsForCompletedVisit } = await import(
      "@/server/commissions/engine"
    );
    const { db } = await import("@/lib/db");
    const { visits } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.transaction(async (tx) => {
      await tx
        .update(visits)
        .set({ status: "COMPLETED", updatedAt: new Date() })
        .where(eq(visits.id, visitId));
      await generateCommissionsForCompletedVisit(tx, visitId, adminId);
    });

    const sql2 = postgres(testDb.url, { max: 1 });
    try {
      // Work items frozen with server-computed totals (match by service).
      const items = await sql2`SELECT service_id, total FROM visit_work_items WHERE visit_id = ${visitId}`;
      expect(items.length).toBe(2);
      const itemA = items.find((row) => row.service_id === serviceAId)!;
      const itemB = items.find((row) => row.service_id === serviceBId)!;
      expect(Number(itemA.total)).toBe(14000); // 1×15000 − 1000
      expect(Number(itemB.total)).toBe(10000); // 2×5000

      // Exactly ONE commission (service A only — B is not eligible).
      const commissions = await sql2`SELECT id, base_amount, amount, status, plan_type, plan_value FROM commissions WHERE doctor_id = ${doctorId}`;
      expect(commissions.length).toBe(1);
      expect(Number(commissions[0]!.base_amount)).toBe(14000);
      // No plan configured yet → PENDING with NULL amount.
      expect(commissions[0]!.status).toBe("PENDING");
      expect(commissions[0]!.amount).toBeNull();
    } finally {
      await sql2.end();
    }

    // Locked: adding a work item to the COMPLETED visit is refused.
    const locked = await addWorkItem(actor, visitId, {
      serviceId: serviceAId,
      doctorId,
      quantity: "1",
      unitPrice: "1.00",
      discount: null,
      currency: "YER",
      notes: null,
    });
    expect(locked).toEqual({ ok: false, code: "visitLocked" });
  });

  it("configures a plan, backfills the amount, approves and pays via payment voucher", async () => {
    const {
      approveCommission,
      payCommission,
      savePlan,
      setCommissionAmount,
    } = await import("@/server/commissions/engine");
    const actor = { id: adminId, role: "ADMIN" as const, name: "مدير" };

    // Save a 25% WORK_VALUE plan for the doctor (default, no service).
    const plan = await savePlan(actor, {
      doctorId,
      serviceId: null,
      basis: "WORK_VALUE",
      type: "PERCENT",
      value: "25.00",
    });
    expect(plan.ok).toBe(true);

    const sql = postgres(testDb.url, { max: 1 });
    let commissionId = "";
    try {
      const [commission] = await sql`SELECT id FROM commissions WHERE doctor_id = ${doctorId} LIMIT 1`;
      commissionId = commission!.id;
    } finally {
      await sql.end();
    }

    // PENDING with no amount: approve is refused until an amount is set.
    const earlyApprove = await approveCommission(actor, commissionId);
    expect(earlyApprove).toEqual({ ok: false, code: "noAmount" });

    // ADMIN sets the amount (25% of 14000 = 3500).
    const set = await setCommissionAmount(actor, commissionId, "3500.00");
    expect(set.ok).toBe(true);

    const approved = await approveCommission(actor, commissionId);
    expect(approved.ok).toBe(true);

    // Pay through a YER cash account → creates a linked payment voucher.
    const sql2 = postgres(testDb.url, { max: 1 });
    let yerAccountId = "";
    try {
      const [account] = await sql2`SELECT id FROM cash_accounts WHERE currency = 'YER' LIMIT 1`;
      yerAccountId = account!.id;
    } finally {
      await sql2.end();
    }

    const paid = await payCommission(actor, commissionId, {
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
    });
    expect(paid.ok).toBe(true);

    const sql3 = postgres(testDb.url, { max: 1 });
    try {
      const [row] = await sql3`SELECT status, paid_voucher_id, amount FROM commissions WHERE id = ${commissionId}`;
      expect(row!.status).toBe("PAID");
      expect(Number(row!.amount)).toBe(3500);

      const [voucher] = await sql3`SELECT type, party_type, doctor_id, commission_id, amount, currency FROM vouchers WHERE id = ${row!.paid_voucher_id}`;
      expect(voucher!.type).toBe("PAYMENT");
      expect(voucher!.party_type).toBe("DOCTOR");
      expect(voucher!.commission_id).toBe(commissionId);
      expect(Number(voucher!.amount)).toBe(3500);

      // Re-generation for the same visit never duplicates the commission.
      const [visitRow] = await sql3`SELECT id FROM visits WHERE patient_id = ${patientId} ORDER BY created_at DESC LIMIT 1`;
      const { generateCommissionsForCompletedVisit } = await import(
        "@/server/commissions/engine"
      );
      const { db } = await import("@/lib/db");
      await db.transaction(async (tx) => {
        await generateCommissionsForCompletedVisit(tx, visitRow!.id, adminId);
      });
      const count = await sql3`SELECT count(*)::int AS n FROM commissions WHERE doctor_id = ${doctorId}`;
      expect(count[0]!.n).toBe(1);
    } finally {
      await sql3.end();
    }
  });

  it("runs the lab flow: case → invoice → partial payment → remaining", async () => {
    const { createLabCase, invoiceLabCase } = await import("@/server/labs/labs");
    const { createPaymentVoucher } = await import("@/server/finance/vouchers");
    const { getLabBalances } = await import("@/server/labs/labs");
    const actor = { id: adminId, role: "ADMIN" as const, name: "مدير" };

    const sql = postgres(testDb.url, { max: 1 });
    let labId = "";
    let yerAccountId = "";
    try {
      const lab = await sql`INSERT INTO labs (id, name, active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'معمل الاختبار', true, now(), now()) RETURNING id`;
      labId = lab[0]!.id;
      const [account] = await sql`SELECT id FROM cash_accounts WHERE currency = 'YER' LIMIT 1`;
      yerAccountId = account!.id;
    } finally {
      await sql.end();
    }

    const created = await createLabCase(actor, {
      labId,
      patientId,
      visitId: null,
      doctorId,
      serviceId: serviceAId,
      workType: "تيجان زيركون",
      cost: "12000.00",
      currency: "YER",
      status: "SENT",
      sentAt: new Date(),
      expectedDeliveryAt: null,
    });
    expect(created.ok).toBe(true);

    const invoiced = await invoiceLabCase(actor, created.ok ? created.id : "", {
      invoiceNumber: "LAB-INV-1",
      invoiceAmount: "12000.00",
    });
    expect(invoiced.ok).toBe(true);

    // Double invoicing is refused.
    const again = await invoiceLabCase(actor, created.ok ? created.id : "", {});
    expect(again).toEqual({ ok: false, code: "duplicate" });

    // Partial payment (5000 of 12000) via payment voucher linked to the lab.
    const payment = await createPaymentVoucher(actor, {
      party: { kind: "LAB", labId },
      amount: "5000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
    });
    expect(payment.ok).toBe(true);

    const balances = await getLabBalances();
    const labBalance = balances.find((row) => row.labId === labId);
    expect(labBalance).toBeDefined();
    expect(labBalance!.invoicedMinor).toBe(1200000);
    expect(labBalance!.paidMinor).toBe(500000);
    expect(labBalance!.balanceMinor).toBe(700000); // المتبقي
  });

  it("runs the supplier flow: multi-line invoice → partial payment → balance", async () => {
    const {
      createMaterial,
      createPurchaseInvoice,
      createSupplier,
      getSupplierBalances,
    } = await import("@/server/suppliers/suppliers");
    const { createPaymentVoucher } = await import("@/server/finance/vouchers");
    const actor = { id: adminId, role: "ADMIN" as const, name: "مدير" };

    const sql = postgres(testDb.url, { max: 1 });
    let yerAccountId = "";
    try {
      const [account] = await sql`SELECT id FROM cash_accounts WHERE currency = 'YER' LIMIT 1`;
      yerAccountId = account!.id;
    } finally {
      await sql.end();
    }

    const supplier = await createSupplier(actor, { name: "مورد الاختبار" });
    expect(supplier.ok).toBe(true);

    const materialA = await createMaterial(actor, {
      code: "MAT-1",
      nameAr: "قوالب",
      nameEn: "Impression trays",
    });
    const materialB = await createMaterial(actor, {
      code: "MAT-2",
      nameAr: "قفازات",
      nameEn: "Gloves",
    });
    expect(materialA.ok && materialB.ok).toBe(true);

    const invoice = await createPurchaseInvoice(actor, {
      supplierId: supplier.ok ? supplier.id : "",
      currency: "YER",
      items: [
        { materialId: materialA.ok ? materialA.id : "", quantity: "10", unitPrice: "1500.00" },
        { materialId: materialB.ok ? materialB.id : "", quantity: "5", unitPrice: "800.00", discount: "500.00" },
      ],
    });
    expect(invoice.ok).toBe(true);

    const sql2 = postgres(testDb.url, { max: 1 });
    try {
      // Server-computed totals: 10×1500 = 15000; 5×800 − 500 = 3500 → 18500.
      const [row] = await sql2`SELECT total_amount FROM purchase_invoices WHERE id = ${invoice.ok ? invoice.id : ""}`;
      expect(Number(row!.total_amount)).toBe(18500);

      const itemCount = await sql2`SELECT count(*)::int AS n FROM purchase_invoice_items WHERE invoice_id = ${invoice.ok ? invoice.id : ""}`;
      expect(itemCount[0]!.n).toBe(2);
    } finally {
      await sql2.end();
    }

    // Partial payment (10000 of 18500).
    const payment = await createPaymentVoucher(actor, {
      party: {
        kind: "SUPPLIER",
        supplierId: supplier.ok ? supplier.id : "",
        purchaseInvoiceId: invoice.ok ? invoice.id : null,
      },
      amount: "10000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "TRANSFER",
    });
    expect(payment.ok).toBe(true);

    const balances = await getSupplierBalances();
    const supplierBalance = balances.find((row) => row.supplierId === (supplier.ok ? supplier.id : ""));
    expect(supplierBalance).toBeDefined();
    expect(supplierBalance!.invoicedMinor).toBe(1850000);
    expect(supplierBalance!.paidMinor).toBe(1000000);
    expect(supplierBalance!.balanceMinor).toBe(850000); // المتبقي
  });

  it("reverses a supplier payment voucher: balance restored, nothing deleted", async () => {
    const { createPaymentVoucher, reverseVoucher } = await import(
      "@/server/finance/vouchers"
    );
    const { getSupplierBalances } = await import("@/server/suppliers/suppliers");
    const actor = { id: adminId, role: "ADMIN" as const, name: "مدير" };

    const balancesBefore = await getSupplierBalances();
    const target = balancesBefore[0]!;

    const sql = postgres(testDb.url, { max: 1 });
    let yerAccountId = "";
    try {
      const [account] = await sql`SELECT id FROM cash_accounts WHERE currency = 'YER' LIMIT 1`;
      yerAccountId = account!.id;
    } finally {
      await sql.end();
    }

    const payment = await createPaymentVoucher(actor, {
      party: { kind: "SUPPLIER", supplierId: target!.supplierId },
      amount: "1000.00",
      currency: "YER",
      cashAccountId: yerAccountId,
      paymentMethod: "CASH",
    });
    expect(payment.ok).toBe(true);

    const reversed = await reverseVoucher(actor, payment.ok ? payment.id : "", "دفع مكرر");
    expect(reversed.ok).toBe(true);

    const balancesAfter = await getSupplierBalances();
    const after = balancesAfter.find((row) => row.supplierId === target!.supplierId);
    expect(after!.balanceMinor).toBe(target.balanceMinor); // restored

    const sql2 = postgres(testDb.url, { max: 1 });
    try {
      // Both rows exist — the original marked REVERSED, the counterpart linked.
      const rows = await sql2`SELECT status, reversal_of_voucher_id FROM vouchers WHERE id = ${payment.ok ? payment.id : ""} OR id = ${reversed.ok ? reversed.id : ""}`;
      expect(rows.length).toBe(2);
    } finally {
      await sql2.end();
    }
  });

});
