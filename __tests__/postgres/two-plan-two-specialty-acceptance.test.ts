import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import type { Currency } from "../../lib/money";

/**
 * Mandate §8 acceptance: one patient with two plans, two specialties, two doctors and two
 * currencies. Work, receipts, balances, visit sources and doctor commission stay with their
 * own case; nothing crosses to the other plan, doctor or currency. A visit whose work has no
 * explicit source stays unresolved rather than borrowing either plan. Observation only: no
 * product behaviour is changed here. Synthetic data only.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_two_plan_acceptance_test");
const db = await import("../../lib/db");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { getVisitFinancialContext } = await import("../../lib/visit-financial-context-db");

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
const FAR_PAST = "2000-01-01", FAR_FUTURE = "2999-12-31";

type Track = {
  label: string; currency: Currency; specialty: string; service: number; category: string; doctor: number;
  tooth: number; priceMinor: number; paidMinor: number;
  invoiceId: number; planId: number; planItemId: number; caseId: number; visitId: number;
};
let patientId = 0;
const tracks: Track[] = [];
let looseVisitId = 0;

async function doctorParty(name: string, percent: number) {
  return (await q<{ id: number }>(`INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', $1, $2) RETURNING id`, [name, percent]))[0].id;
}
async function service(name: string, category: string) {
  return (await q<{ id: number }>(`INSERT INTO services (name, category, price_minor, price_sar_minor, price_usd_minor, price_configured, is_active)
    VALUES ($1, $2, 100000, 100000, 100000, TRUE, TRUE) RETURNING id`, [name, category]))[0].id;
}

beforeAll(async () => {
  await db.ensureSchema();
  await db.openShift({ openedBy: "two-plan-cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  await q(`INSERT INTO settings (key, value) VALUES ('finance.rate.SAR', '140'), ('finance.rate.USD', '530')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  [{ id: patientId }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('TWO-PLAN-1', 'Synthetic two-plan patient') RETURNING id`);
  const endoDoctor = await doctorParty("Synthetic endodontist", 30);
  const prosthoDoctor = await doctorParty("Synthetic prosthodontist", 40);
  // Both real entry flows: an invoice-first plan, then a plan-first agreement in another
  // currency. While one plan is active, an invoice may not open a second plan by itself
  // (reusableMaster → incompatible_plan); the second plan is created explicitly and its
  // consented item is then invoiced.
  const specs = [
    { label: "endo", flow: "invoice-first" as const, currency: "YER" as Currency, specialty: "endodontics", category: "rct",
      service: await service("Synthetic root canal", "rct"), doctor: endoDoctor, tooth: 36, priceMinor: 8_000_000, paidMinor: 8_000_000 },
    { label: "prostho", flow: "plan-first" as const, currency: "SAR" as Currency, specialty: "prosthodontics", category: "crown",
      service: await service("Synthetic zirconia crown", "crown"), doctor: prosthoDoctor, tooth: 14, priceMinor: 150_000, paidMinor: 60_000 },
  ];
  for (const spec of specs) {
    let agreedPlanId: number | null = null;
    if (spec.flow === "plan-first") {
      const plan = await db.createPlanV2({ patientId, title: "Synthetic prosthodontic agreement", specialty: null, primaryDoctorId: spec.doctor,
        billingMode: "per_procedure", baseCurrency: spec.currency, startDate: "2026-10-01", note: null, createdBy: "two-plan-doctor", installments: [],
        items: [{ serviceId: spec.service, serviceName: spec.label, category: spec.category, toothCode: spec.tooth, surfaces: null, quantity: 1,
          unitPriceMinor: spec.priceMinor, billingRule: "on_completion", sessionCount: 1, note: null }] });
      if (!plan.ok) throw new Error(plan.message);
      agreedPlanId = plan.planId;
      expect(await db.recordPlanConsent({ planId: plan.planId, actor: "two-plan-doctor", note: "Synthetic explicit consent" })).toMatchObject({ ok: true });
    }
    // Real write path: the invoice links (or creates) the plan item and specialty case in one transaction.
    const created = await createLinkedInvoice({
      patientId, baseCurrency: spec.currency, discountMinor: 0, note: null, createdBy: "two-plan-reception", actorRole: "reception",
      items: [{ serviceId: spec.service, category: spec.category, doctorId: spec.doctor, description: spec.label, quantity: 1,
        unitPriceMinor: spec.priceMinor, toothCode: spec.tooth, caseId: null, sessions: null }],
      templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {},
    });
    if (!created.ok) throw new Error(`Synthetic ${spec.label} invoice failed: ${JSON.stringify(created)}`);
    const link = created.links[0];
    const planId = agreedPlanId ?? created.planId;
    if (planId === null) throw new Error(`Synthetic ${spec.label} plan missing`);
    if (spec.flow === "invoice-first") {
      expect(await db.recordPlanConsent({ planId, actor: "two-plan-reception", note: "Synthetic explicit consent" })).toMatchObject({ ok: true });
    } else {
      // The consented agreement item was reused, not duplicated into another plan.
      expect(created.planId).toBeNull();
      expect(await q(`SELECT plan_id FROM plan_items WHERE id = $1`, [link.planItemId])).toEqual([{ plan_id: agreedPlanId }]);
    }
    const visit = await db.addVisit({ patientId, patientName: "Synthetic two-plan patient", patientPhone: null, note: null, doctorId: spec.doctor });
    expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId: spec.service, toothCode: spec.tooth, surfaces: null,
      quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId: spec.doctor, note: null, planItemId: link.planItemId! }] })).toBe(true);
    expect(await db.signClinicalVisit({ visitId: visit.id, baseCurrency: spec.currency, signedBy: spec.label, signerDoctorPartyId: spec.doctor }))
      .toMatchObject({ reason: null, invoiceId: null });
    const paid = await db.recordPayment({ patientId, invoiceId: created.invoice.id, kind: "payment", amountMinor: spec.paidMinor, currency: spec.currency,
      baseCurrency: "YER", exchangeRate: spec.currency === "SAR" ? 140 : 1, method: "cash", note: null, createdBy: "two-plan-cashier",
      idempotencyKey: `two-plan-${spec.label}` });
    expect(paid.reason).toBeNull();
    tracks.push({ ...spec, invoiceId: created.invoice.id, planId, planItemId: link.planItemId!, caseId: link.caseId!, visitId: visit.id });
  }
  // Control: work recorded with no plan item, no invoice line and no decision.
  const loose = await db.addVisit({ patientId, patientName: "Synthetic two-plan patient", patientPhone: null, note: null, doctorId: specs[0].doctor });
  expect(await db.setVisitProcedures({ visitId: loose.id, procedures: [{ serviceId: specs[1].service, toothCode: 15, surfaces: null,
    quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId: specs[0].doctor, note: null, planItemId: null }] })).toBe(true);
  looseVisitId = loose.id;
}, 240_000);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("two plans × two specialties × two doctors × two currencies", () => {
  it("each plan keeps its own invoice, currency, doctor, case and specialty", async () => {
    expect(tracks).toHaveLength(2);
    expect(new Set(tracks.map(t => t.planId)).size).toBe(2);
    expect(new Set(tracks.map(t => t.caseId)).size).toBe(2);
    expect(await q(`SELECT id, base_currency FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId]))
      .toEqual(tracks.map(t => ({ id: t.invoiceId, base_currency: t.currency })));
    for (const t of tracks) {
      expect(await q(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [t.invoiceId])).toEqual([{ doctor_id: t.doctor }]);
      expect(await q(`SELECT plan_id, case_id FROM plan_items WHERE id = $1`, [t.planItemId])).toEqual([{ plan_id: t.planId, case_id: t.caseId }]);
      expect(await q(`SELECT specialty FROM clinical_cases WHERE id = $1`, [t.caseId])).toEqual([{ specialty: t.specialty }]);
      expect(await q(`SELECT base_currency FROM treatment_plans WHERE id = $1`, [t.planId])).toEqual([{ base_currency: t.currency }]);
    }
  });

  it("each signed visit holds only its own plan item and doctor; signing billed nothing new", async () => {
    for (const t of tracks) {
      expect(await q(`SELECT plan_item_id, doctor_id FROM visit_procedures WHERE visit_id = $1`, [t.visitId]))
        .toEqual([{ plan_item_id: t.planItemId, doctor_id: t.doctor }]);
    }
    expect(await q(`SELECT count(*)::int AS n FROM invoices WHERE patient_id = $1`, [patientId])).toEqual([{ n: 2 }]);
  });

  it("each receipt settles only its own invoice in its own currency; balances stay per currency", async () => {
    expect(await q(`SELECT invoice_id, currency, amount_minor::bigint::text AS amount FROM payments WHERE patient_id = $1 ORDER BY id`, [patientId]))
      .toEqual(tracks.map(t => ({ invoice_id: t.invoiceId, currency: t.currency, amount: String(t.paidMinor) })));
    const ledger = await db.patientLedger(patientId);
    const balances = db.ledgerBalancesByCurrency(patientId, ledger, new Map());
    for (const t of tracks) {
      expect(balances[t.currency]).toMatchObject({ billedMinor: t.priceMinor, collectedMinor: t.paidMinor, dueMinor: t.priceMinor - t.paidMinor });
    }
    expect(balances.USD).toMatchObject({ billedMinor: 0, collectedMinor: 0, dueMinor: 0 });
  });

  it("each visit's financial context names only its own invoice; the unlinked visit stays unresolved", async () => {
    for (const t of tracks) {
      const context = await getVisitFinancialContext(t.visitId, patientId);
      expect(context?.summary).toBe("verified");
      const ids = context!.work.flatMap(line => line.references.map(source => `${source.kind}:${source.id}`));
      expect(ids.length).toBeGreaterThan(0);
      for (const other of tracks.filter(o => o !== t)) {
        expect(ids).not.toContain(`invoice:${other.invoiceId}`);
        expect(ids).not.toContain(`plan_item:${other.planItemId}`);
      }
    }
    const loose = await getVisitFinancialContext(looseVisitId, patientId);
    expect(loose?.summary).not.toBe("verified");
    expect(loose!.work.flatMap(line => line.references)).toEqual([]);
  });

  it("doctor commission accrues only to the performing doctor, only in that plan's currency", async () => {
    const rows = await db.commissionReport(FAR_PAST, FAR_FUTURE);
    for (const t of tracks) {
      const mine = rows.filter(row => row.doctorId === t.doctor && (row.accruedMinor !== 0 || row.earnedMinor !== 0));
      expect(mine.map(row => row.currency)).toEqual([t.currency]);
      expect(mine[0].accruedMinor).toBeGreaterThan(0);
      expect(mine[0].earnedMinor).toBeGreaterThan(0);
      expect(mine[0].earnedMinor).toBeLessThanOrEqual(mine[0].accruedMinor);
    }
    const partial = tracks.find(t => t.paidMinor < t.priceMinor)!, full = tracks.find(t => t.paidMinor === t.priceMinor)!;
    const row = (t: Track) => rows.find(r => r.doctorId === t.doctor && r.currency === t.currency)!;
    // Partial collection earns less than the accrual; full collection earns all of it.
    expect(row(partial).earnedMinor).toBeLessThan(row(partial).accruedMinor);
    expect(row(full).earnedMinor).toBe(row(full).accruedMinor);
  });
});
