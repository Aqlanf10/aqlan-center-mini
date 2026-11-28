import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  commissionForPatientAtEventTime,
  labCostAllocationProblem,
  splitShareByParticipation,
  type CommissionInvoice,
  type DoctorShareItem,
} from "../lib/commission";
import { COMMISSION_LAB_COST_ALLOCATION_SQL } from "../lib/commission-lab-cost-allocation-schema";
import { parseCaseParticipationRequest } from "../lib/commission-participation-input";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  CLINIC_TIME_ZONE,
  commissionReport,
  ensureSchema,
  getPool,
  openShift,
  resetPoolForTesting,
} = await import("../lib/db");

describe("Charter §17, §18 & §16: Commission Consumption Base Math, Per-Service Exemption, and Shared Lab-Cost Allocation", () => {
  const FIXTURE_DAY = "2026-09-15";

  beforeAll(async () => {
    await ensureSchema();
    // Install proposal 0134 & 0141 on the isolated test database
    await getPool().query(COMMISSION_LAB_COST_ALLOCATION_SQL);
    await getPool().query(
      "ALTER TABLE services ADD COLUMN IF NOT EXISTS material_consumption_exempt BOOLEAN NOT NULL DEFAULT FALSE",
    );
    await openShift({ openedBy: "commission-charter-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  }, 60_000);

  afterAll(async () => {
    await resetPoolForTesting();
  });

  it("Charter §17 exact formula: 10,000 collected, 2,000 lab, 20% of the remainder (1,600), 40% doctor rate => 2,560 YER", async () => {
    // Pure engine proof first
    const inv: CommissionInvoice = {
      id: 9001,
      netMinor: 10_000,
      currency: "YER",
      createdAt: "2026-09-15T10:00:00Z",
      doctorShares: [
        {
          doctorId: 501,
          amountMinor: 10_000,
          currency: "YER",
          category: "تركيبات_اختبار_17",
          labCostMinor: 2_000,
        },
      ],
    };
    const engineMap = commissionForPatientAtEventTime(
      [inv],
      [{ invoiceId: 9001, amount: 10_000, sourceTime: "2026-09-15T11:00:00Z" }],
      () => ({ percent: 40, config: null }),
      undefined,
      { materialRateAt: () => 2000 },
    );
    expect(engineMap.get(501)?.YER).toEqual({
      accruedMinor: 3_200, // (10,000 - 2,000) * 40%
      earnedMinor: 3_200,
      netEarnedAfterMaterialRateMinor: 2_560, // (10,000 - 2,000) × 80% × 40%
    });

    const half = commissionForPatientAtEventTime(
      [inv], [{ invoiceId: 9001, amount: 5_000, sourceTime: "2026-09-15T11:00:00Z" }],
      () => ({ percent: 40, config: null }), undefined, { materialRateAt: () => 2000 },
    );
    expect(half.get(501)?.YER.netEarnedAfterMaterialRateMinor).toBe(1_280);

    // End-to-end database commissionReport proof
    await getPool().query(
      `INSERT INTO settings (key, value) VALUES ('finance.commission_material_rate', 'on')
       ON CONFLICT (key) DO UPDATE SET value = 'on'`,
    );
    await getPool().query(
      `INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
       VALUES ('تركيبات_اختبار_17', 2000, TIMESTAMPTZ '2026-09-01 00:00:00+00', 'test')`,
    );

    const { rows: [doctor] } = await getPool().query<{ id: number }>(
      `INSERT INTO parties (name, kind, commission_percent, is_active)
       VALUES ('د. اختبار معادلة 2560', 'doctor', 40, TRUE) RETURNING id`,
    );
    const { rows: [lab] } = await getPool().query<{ id: number }>(
      `INSERT INTO parties (name, kind, currency, is_active)
       VALUES ('مختبر اختبار 2560', 'lab', 'YER', TRUE) RETURNING id`,
    );
    const { rows: [service] } = await getPool().query<{ id: number }>(
      `INSERT INTO services (name, category, price_minor, is_active)
       VALUES ('تاج خزفي معادلة 2560', 'تركيبات_اختبار_17', 10000, TRUE) RETURNING id`,
    );
    const { rows: [patient] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name)
       VALUES ('P-99701', 'مريض اختبار معادلة 2560') RETURNING id`,
    );
    const { rows: [invoice] } = await getPool().query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
       VALUES ('INV-CHARTER17-1', $1, 10000, 0, 'YER', 'test', ($2::date + TIME '10:00') AT TIME ZONE $3)
       RETURNING id`,
      [patient.id, FIXTURE_DAY, CLINIC_TIME_ZONE],
    );
    await getPool().query(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
       VALUES ($1, $2, 'تاج خزفي', 1, 10000, 10000, $3)`,
      [invoice.id, service.id, doctor.id],
    );
    const { rows: [visit] } = await getPool().query<{ id: number }>(
      `INSERT INTO visits (patient_id, patient_name, doctor_id, invoice_id, status, arrived_at)
       VALUES ($1, 'مريض اختبار معادلة 2560', $2, $3, 'done', ($4::date + TIME '09:30') AT TIME ZONE $5)
       RETURNING id`,
      [patient.id, doctor.id, invoice.id, FIXTURE_DAY, CLINIC_TIME_ZONE],
    );
    await getPool().query(
      `INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, visit_id, doctor_id, status, cost_minor, cost_currency)
       VALUES ($1, 'مختبر اختبار 2560', 'تاج زيركون', $4::date, $2, $3, 'delivered', 2000, 'YER')`,
      [patient.id, visit.id, doctor.id, FIXTURE_DAY],
    );
    const { rows: [shift] } = await getPool().query<{ id: number }>(
      `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
    );
    await getPool().query(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
         exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
       VALUES ('R-CHARTER17-1', $1, $2, $3, 'payment', 10000, 'YER', 1, 10000, 'YER', 'cash', 'test',
               ($4::date + TIME '11:00') AT TIME ZONE $5)`,
      [patient.id, invoice.id, shift.id, FIXTURE_DAY, CLINIC_TIME_ZONE],
    );

    const rows = await commissionReport(FIXTURE_DAY, FIXTURE_DAY);
    const row = rows.find((r) => r.doctorId === doctor.id && r.currency === "YER");
    expect(row).toBeDefined();
    expect(row!.labCostMinor).toBe(2_000);
    expect(row!.materialRateCostMinor).toBe(1_600);
    expect(row!.earnedMinor).toBe(3_200);
    expect(row!.netEarnedMinor).toBe(2_560);
    expect(row!.dueMinor).toBe(2_560);
  });

  it("Charter §18 (proposal 0141): exempts consultation services marked material_consumption_exempt = TRUE", async () => {
    const { rows: [doctor] } = await getPool().query<{ id: number }>(
      `INSERT INTO parties (name, kind, commission_percent, is_active)
       VALUES ('د. اختبار استثناء الاستشارة', 'doctor', 40, TRUE) RETURNING id`,
    );
    const { rows: [exemptService] } = await getPool().query<{ id: number }>(
      `INSERT INTO services (name, category, price_minor, is_active, material_consumption_exempt)
       VALUES ('كشف واستشارة تقويمية معفاة', 'تركيبات_اختبار_17', 5000, TRUE, TRUE) RETURNING id`,
    );
    const { rows: [patient] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name)
       VALUES ('P-99702', 'مريض استشارة معفاة') RETURNING id`,
    );
    const { rows: [invoice] } = await getPool().query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
       VALUES ('INV-EXEMPT-1', $1, 5000, 0, 'YER', 'test', ($2::date + TIME '12:00') AT TIME ZONE $3)
       RETURNING id`,
      [patient.id, FIXTURE_DAY, CLINIC_TIME_ZONE],
    );
    await getPool().query(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
       VALUES ($1, $2, 'استشارة معفاة', 1, 5000, 5000, $3)`,
      [invoice.id, exemptService.id, doctor.id],
    );
    const { rows: [shift] } = await getPool().query<{ id: number }>(
      `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
    );
    await getPool().query(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
         exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
       VALUES ('R-EXEMPT-1', $1, $2, $3, 'payment', 5000, 'YER', 1, 5000, 'YER', 'cash', 'test',
               ($4::date + TIME '12:30') AT TIME ZONE $5)`,
      [patient.id, invoice.id, shift.id, FIXTURE_DAY, CLINIC_TIME_ZONE],
    );

    const rows = await commissionReport(FIXTURE_DAY, FIXTURE_DAY);
    const row = rows.find((r) => r.doctorId === doctor.id && r.currency === "YER");
    expect(row).toBeDefined();
    expect(row!.materialRateCostMinor).toBe(0);
    expect(row!.earnedMinor).toBe(2_000); // 5,000 * 40%
    expect(row!.netEarnedMinor).toBe(2_000); // Zero material consumption deducted!
  });

  it("Charter §16 (proposal 0134): allocates shared-case lab cost by work shares, admin allocation, or line-doctor fallback", () => {
    const share: DoctorShareItem = {
      doctorId: 10,
      amountMinor: 10_000,
      currency: "YER",
      labCostMinor: 2_000,
      caseId: 77,
    };

    // 1. Default work_shares: 60/40 splits both revenue (6000/4000) and lab cost (1200/800)
    const byWork = splitShareByParticipation(share, {
      caseId: 77,
      status: "approved",
      labCostBasis: "work_shares",
      participants: [
        { doctorId: 10, shareBp: 6_000 },
        { doctorId: 20, shareBp: 4_000 },
      ],
    });
    expect(byWork.map((s) => ({ doctorId: s.doctorId, amount: s.amountMinor, lab: s.labCostMinor, basis: s.labCostBasis }))).toEqual([
      { doctorId: 10, amount: 6_000, lab: 1_200, basis: "work_shares" },
      { doctorId: 20, amount: 4_000, lab: 800, basis: "work_shares" },
    ]);

    // 2. Administrative labCostBp (100% on doctor 20, 0% on doctor 10)
    const byAdmin = splitShareByParticipation(share, {
      caseId: 77,
      status: "approved",
      labCostBasis: "admin_allocation",
      participants: [
        { doctorId: 10, shareBp: 6_000, labCostBp: 0 },
        { doctorId: 20, shareBp: 4_000, labCostBp: 10_000 },
      ],
    });
    expect(byAdmin.map((s) => ({ doctorId: s.doctorId, amount: s.amountMinor, lab: s.labCostMinor, basis: s.labCostBasis }))).toEqual([
      { doctorId: 10, amount: 6_000, lab: 0, basis: "admin_allocation" },
      { doctorId: 20, amount: 4_000, lab: 2_000, basis: "admin_allocation" },
    ]);

    // 3. Both switches off => safe line_doctor fallback
    const byLineDoctor = splitShareByParticipation(share, {
      caseId: 77,
      status: "approved",
      labCostBasis: "line_doctor",
      participants: [
        { doctorId: 10, shareBp: 6_000 },
        { doctorId: 20, shareBp: 4_000 },
      ],
    });
    expect(byLineDoctor.map((s) => ({ doctorId: s.doctorId, lab: s.labCostMinor, basis: s.labCostBasis }))).toEqual([
      { doctorId: 10, lab: 2_000, basis: "line_doctor" },
      { doctorId: 20, lab: 0, basis: "line_doctor" },
    ]);

    // 4. Input & invariant validation refuses partial or non-10000 labCostBp
    expect(labCostAllocationProblem([{ doctorId: 10, shareBp: 6_000, labCostBp: 6_000 }, { doctorId: 20, shareBp: 4_000 }])).toBe("incomplete");
    expect(labCostAllocationProblem([{ doctorId: 10, shareBp: 6_000, labCostBp: 5_000 }, { doctorId: 20, shareBp: 4_000, labCostBp: 4_000 }])).toBe("incomplete");
    expect(labCostAllocationProblem([{ doctorId: 10, shareBp: 6_000, labCostBp: 2_500 }, { doctorId: 20, shareBp: 4_000, labCostBp: 7_500 }])).toBeNull();

    const parsed = parseCaseParticipationRequest({
      caseId: 77,
      status: "approved",
      source: "centre_decision",
      reason: "توزيع تكلفة المختبر إداريًا",
      expectedHeadId: null,
      participants: [
        { doctorId: 10, shareBp: 6_000, labCostBp: 2_500 },
        { doctorId: 20, shareBp: 4_000, labCostBp: 7_500 },
      ],
    });
    expect(parsed.ok).toBe(true);
  });
});
