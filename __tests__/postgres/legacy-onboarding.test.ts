import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-A) تهيئة مريض التقويم السابق على PostgreSQL 18: القائمة تُشتق من القطع القائمة (لقطة الحالة،
 * الرصيد السابق، ترتيب تحصيله، خطة الأقساط) وتطابق تصنيف الشدّة الذي يقرره التوقيع — ولا تكتب شيئًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting, setPatientOpeningBalance } = db;
const { createLegacyBalanceArrangement } = await import("../../lib/legacy-balance-arrangements-db");
const { patientLegacyOnboarding } = await import("../../lib/legacy-onboarding-db");
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function patient(number: string): Promise<number> {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض تقويم') RETURNING id`, [number]))[0].id;
}

async function legacyCase(patientId: number, mode: string | null, planId: number | null = null): Promise<number> {
  return (await q<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode, plan_id)
     VALUES ($1, 'migration', 'legacy', NOW(), $2, $3) RETURNING id`, [patientId, mode, planId]))[0].id;
}

async function counts() {
  return q(`SELECT (SELECT count(*) FROM invoices)::int AS invoices, (SELECT count(*) FROM payments)::int AS payments,
                   (SELECT count(*) FROM patient_opening_balances)::int AS openings,
                   (SELECT count(*) FROM legacy_balance_arrangements)::int AS arrangements,
                   (SELECT count(*) FROM ortho_cases)::int AS cases`);
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(P1-A) legacy ortho onboarding checklist on PG18", () => {
  it("no open ortho case ⇒ null", async () => {
    expect(await patientLegacyOnboarding(await patient("ONB-0"))).toBeNull();
  });

  it("opening_balance: missing balance → incomplete/OUTSIDE_CONTRACT; recorded → complete/LEGACY_INCLUDED; arrangement → done", async () => {
    const patientId = await patient("ONB-1");
    const caseId = await legacyCase(patientId, "opening_balance");
    const before = await counts();
    const missing = await patientLegacyOnboarding(patientId);
    expect(await counts()).toEqual(before);
    expect(missing).toMatchObject({ caseId, legacy: true, complete: false, adjustmentClass: "OUTSIDE_CONTRACT" });
    expect(missing?.warning).not.toBeNull();

    await setPatientOpeningBalance({
      patientId, currency: "YER", amountMinor: 350_000, asOfDate: today, note: null, createdBy: "migration", reason: null,
    });
    const recorded = await patientLegacyOnboarding(patientId);
    expect(recorded).toMatchObject({ complete: true, adjustmentClass: "LEGACY_INCLUDED", warning: null });
    expect(recorded?.steps.find((step) => step.key === "arrangement")).toMatchObject({ done: false, optional: true });

    const arrangement = await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "per_visit", installmentMinor: 30_000, firstDueDate: null,
      note: null, createdBy: "reception", today,
    });
    expect(arrangement.ok).toBe(true);
    const arranged = await patientLegacyOnboarding(patientId);
    expect(arranged?.steps.find((step) => step.key === "arrangement")?.done).toBe(true);
    /* لا مبالغ في القائمة — يراها الطبيب دون أرقام مالية. */
    expect(JSON.stringify(arranged)).not.toMatch(/350000|30000/);
  });

  it("installments: a plan without installments is not funded; with installments ⇒ INCLUDED and complete", async () => {
    const patientId = await patient("ONB-2");
    const planId = (await q<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'تقويم سابق', 600000) RETURNING id`, [patientId]))[0].id;
    await legacyCase(patientId, "installments", planId);
    expect(await patientLegacyOnboarding(patientId)).toMatchObject({ complete: false, adjustmentClass: "OUTSIDE_CONTRACT" });
    await q(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor) VALUES ($1, 1, $2::date, 100000)`, [planId, today]);
    expect(await patientLegacyOnboarding(patientId)).toMatchObject({ complete: true, adjustmentClass: "INCLUDED", warning: null });
  });

  it("a cancelled arrangement does not count, and a closed case is not onboarded", async () => {
    const patientId = await patient("ONB-3");
    const caseId = await legacyCase(patientId, "opening_balance");
    await setPatientOpeningBalance({
      patientId, currency: "YER", amountMinor: 90_000, asOfDate: today, note: null, createdBy: "migration", reason: null,
    });
    const arrangement = await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "per_visit", installmentMinor: 10_000, firstDueDate: null,
      note: null, createdBy: "reception", today,
    });
    expect(arrangement.ok).toBe(true);
    await q(`UPDATE legacy_balance_arrangements SET cancelled_at = NOW(), cancelled_by = 'admin', cancel_reason = 'اختبار'
              WHERE patient_id = $1`, [patientId]);
    expect((await patientLegacyOnboarding(patientId))?.steps.find((step) => step.key === "arrangement")?.done).toBe(false);
    await q(`UPDATE ortho_cases SET status = 'completed' WHERE id = $1`, [caseId]);
    expect(await patientLegacyOnboarding(patientId)).toBeNull();
  });
});
