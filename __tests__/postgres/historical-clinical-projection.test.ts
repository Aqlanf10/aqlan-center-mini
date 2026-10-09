import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest } from "../../lib/legacy-treatment";
import type { Currency } from "../../lib/money";

// Existing CI disposable PostgreSQL only. No clinic fixture or migration.
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { createLegacyTreatment } = await import("../../lib/legacy-treatment-db");
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query(sql, params)).rows as T[];
const today = "2026-10-09";
let serviceId: number;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  serviceId = (await q<{ id: number }>(`INSERT INTO services (name, category, price_minor, is_active, price_configured)
    VALUES ('Synthetic historical ortho', 'ortho', 300000, TRUE, TRUE) RETURNING id`))[0].id;
}, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });
const patient = async (label: string) => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [`PF14-${label}`]))[0].id;
async function legacy(patientId: number, currency: Currency = "YER", sessions?: number) {
  const request = parseLegacyTreatmentRequest({ serviceId, scope: "both", currency, sessions,
    agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30" }, today);
  if (!request.ok) throw new Error(request.message);
  const result = await createLegacyTreatment({ patientId, request: request.value, actor: "synthetic-admin",
    actorRole: "admin", canEditOpening: true, templates: DEFAULT_SPECIALTY_TEMPLATES });
  if (!result.ok) throw new Error(result.reason);
  return result.agreement;
}
async function footprint(patientId: number) {
  return {
    openings: await q(`SELECT currency, amount_minor::text, as_of_date::text FROM patient_opening_balances WHERE patient_id = $1 ORDER BY currency`, [patientId]),
    cases: await q(`SELECT id, status, ortho_case_id FROM clinical_cases WHERE patient_id = $1 ORDER BY id`, [patientId]),
    invoices: await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId]),
    payments: await q(`SELECT id FROM payments WHERE patient_id = $1`, [patientId]),
    sessions: await q(`SELECT s.* FROM treatment_sessions s JOIN plan_items i ON i.id = s.plan_item_id
      JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY s.id`, [patientId]),
    planned: await q(`SELECT * FROM planned_visits WHERE patient_id = $1 ORDER BY id`, [patientId]),
  };
}

describe("DOT-PF14 historical agreement is not an implicit clinical schedule", () => {
  it.each(["YER", "SAR", "USD"] as const)("keeps original %s money and creates no default visit/session or visit suggestion", async (currency) => {
    const id = await patient(currency);
    const agreement = await legacy(id, currency);
    const before = await footprint(id);
    expect(before.openings).toEqual([{ currency, amount_minor: String(agreement.remainingMinor), as_of_date: "2026-09-30" }]);
    if (currency === "YER") expect(agreement.remainingMinor).toBe(180000);
    expect(before.cases).toHaveLength(1);
    expect(before.invoices).toEqual([]);
    expect(before.payments).toEqual([]);
    expect(before.sessions).toEqual([]);
    expect(before.planned).toEqual([]);
    const summary = await db.patientWorkflow(id, today);
    expect(summary.financial?.byCurrency[currency]).toMatchObject({ balanceMinor: agreement.remainingMinor,
      openingMinor: agreement.remainingMinor, agreedMinor: agreement.agreedMinor,
      clinicalProgress: { historicalItems: 1, knownItems: 0, knownRemainingMinor: 0 } });
    expect(summary.activePlans[0].clinicalProgress?.historicalItems).toBe(1);
    const visit = await db.addVisit({ patientId: id, patientName: "Synthetic", patientPhone: null, note: null });
    const clinical = await db.getClinicalVisit(visit.id);
    expect(clinical?.outstanding).toEqual([]);
    expect(clinical?.suggestions.nextPlan).toBeNull();
    expect(clinical?.activeCases[0]).toMatchObject({ historicalProgressUnknown: true, totalSteps: 0, nextStep: null });
    expect(await footprint(id)).toEqual(before);
  });

  it("keeps an explicitly requested future schedule and its visit suggestion", async () => {
    const id = await patient("explicit");
    const agreement = await legacy(id, "YER", 2);
    const before = await footprint(id);
    expect(before.sessions).toHaveLength(2);
    expect(before.planned).toHaveLength(1);
    const visit = await db.addVisit({ patientId: id, patientName: "Synthetic", patientPhone: null, note: null });
    const clinical = await db.getClinicalVisit(visit.id);
    expect(clinical?.outstanding).toEqual(expect.arrayContaining([expect.objectContaining({ planItemId: agreement.planItemId, sessionCount: 2 })]));
    expect(clinical?.suggestions.nextPlan).toContain("Synthetic historical ortho");
    expect(await footprint(id)).toEqual(before);
  });

  it("preserves previously saved visits and sessions without guessing their provenance", async () => {
    const id = await patient("existing");
    const agreement = await legacy(id);
    // Pre-fix storage shape: the old writer generated a default visit and sessions.
    const planned = (await q<{ id: number }>(`INSERT INTO planned_visits
      (patient_id, plan_id, sequence, title, duration_minutes, status) VALUES ($1, $2, 1, 'Saved future work', 360, 'planned') RETURNING id`, [id, agreement.planId]))[0];
    await q(`INSERT INTO treatment_sessions (plan_item_id, sequence, title, status, planned_visit_id, planned_duration)
      VALUES ($1, 1, 'Saved real work', 'done', $2, 30), ($1, 2, 'Saved planned work', 'planned', $2, 30)`, [agreement.planItemId, planned.id]);
    const before = await footprint(id);
    const summary = await db.patientWorkflow(id, today);
    expect(summary.plannedVisits.map((row) => row.id)).toContain(planned.id);
    const visit = await db.addVisit({ patientId: id, patientName: "Synthetic", patientPhone: null, note: null });
    const clinical = await db.getClinicalVisit(visit.id);
    expect(clinical?.outstanding.map((row) => row.planItemId)).toContain(agreement.planItemId);
    expect(clinical?.suggestions.nextPlan).toContain("Saved future work");
    expect(await footprint(id)).toEqual(before);
  });

  it("keeps new work schedulable and separates mixed clinical progress per original currency", async () => {
    const id = await patient("mixed");
    await legacy(id);
    for (const currency of ["YER", "SAR"] as const) {
      expect(await db.createPlanV2({ patientId: id, title: `Known ${currency}`, specialty: null, primaryDoctorId: null,
        billingMode: "per_procedure", baseCurrency: currency, startDate: today, note: null, createdBy: "synthetic-admin", installments: [],
        items: [{ serviceId, serviceName: `Known ${currency}`, category: "ortho", toothCode: null, surfaces: null,
          quantity: 1, unitPriceMinor: 5000, billingRule: "on_completion", sessionCount: 1, note: null }] })).toMatchObject({ ok: true });
    }
    const summary = await db.patientWorkflow(id, today);
    expect(summary.financial?.byCurrency.YER).toMatchObject({ balanceMinor: 180000,
      clinicalProgress: { historicalItems: 1, knownItems: 1, knownRemainingMinor: 5000 } });
    expect(summary.financial?.byCurrency.SAR).toMatchObject({ balanceMinor: 0,
      clinicalProgress: { historicalItems: 0, knownItems: 1, knownRemainingMinor: 5000 } });
    expect(summary.plannedVisits).toHaveLength(2);
    const state = await footprint(id);
    expect(state.sessions).toHaveLength(2);
    expect(state.payments).toEqual([]);
    expect(state.invoices).toEqual([]);
  });
});
