import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";

// Isolated synthetic PostgreSQL suite only. Never point this at shared/live data.
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { patientLegacyOnboarding } = await import("../../lib/legacy-onboarding-db");
const { listTreatmentFinancialReferences } = await import("../../lib/treatment-financial-context-db");
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.getPool().query(sql, params)).rows as T[];
let doctor = 0, orthoService = 0, rctService = 0, serial = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema();
  doctor = (await q<{ id: number }>("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic reference doctor') RETURNING id"))[0].id;
  orthoService = (await q<{ id: number }>("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic orthodontics','ortho',300000,TRUE,TRUE) RETURNING id"))[0].id;
  rctService = (await q<{ id: number }>("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic endodontics','rct',100000,TRUE,TRUE) RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });
const patient = async () => (await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic reference patient') RETURNING id", [`ORTHO-READ-${++serial}`]))[0].id;
const intake = (patientId: number) => db.createOrthoCase({ patientId, appliance: "fixed_metal", arches: "both", slot: "022",
  bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: "synthetic-doctor" });
const invoice = (patientId: number, mixed = false) => createLinkedInvoice({ patientId, baseCurrency: "YER", discountMinor: 0,
  note: null, createdBy: "synthetic-reception", actorRole: "reception", templates: DEFAULT_SPECIALTY_TEMPLATES,
  idempotencyKey: null, requestHash: null, auditDetails: {}, items: [
    { serviceId: orthoService, category: "ortho", doctorId: doctor, description: "Synthetic orthodontics", quantity: 1, unitPriceMinor: 300000,
      toothCode: null, caseId: null, sessions: null, surfaces: null, episodeTeeth: null, scope: "both" },
    ...(mixed ? [{ serviceId: rctService, category: "rct", doctorId: doctor, description: "Synthetic endodontics", quantity: 1, unitPriceMinor: 100000,
      toothCode: 36, caseId: null, sessions: null, surfaces: null, episodeTeeth: null, scope: null }] : []),
  ] });
const moneyCounts = async (patientId: number) => (await q(`SELECT
  (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
  (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,
  (SELECT count(*)::int FROM plan_installments pi JOIN treatment_plans t ON t.id=pi.plan_id WHERE t.patient_id=$1) AS installments,
  (SELECT count(*)::int FROM debt_repayment_arrangements WHERE patient_id=$1) AS repayments,
  (SELECT coalesce(sum(total_minor),0)::text FROM invoices WHERE patient_id=$1 AND base_currency='YER') AS yer_total`, [patientId]))[0];

describe("real invoice/clinical/Ortho source bridge read", () => {
  it.each(["invoice-first", "ortho-first", "mixed-specialty"])("%s does not require a legacy installment-plan link or grant future adjustments", async order => {
    const patientId = await patient();
    let opened = order === "ortho-first" ? await intake(patientId) : null;
    const billed = await invoice(patientId, order === "mixed-specialty");
    if (!billed.ok) throw new Error(JSON.stringify(billed));
    opened ??= await intake(patientId); if (!opened.ok) throw new Error(opened.message);
    const orthoCaseId = opened.id;
    const before = await moneyCounts(patientId);
    const status = await patientLegacyOnboarding(patientId, orthoCaseId);
    expect(status?.financialReference.state).toBe("linked");
    expect(status?.financialReference.sources).toHaveLength(1);
    expect(status?.financialReference.sources[0]).toMatchObject({ kind: "invoice", sourceId: billed.invoice.id, current: true });
    expect(status?.financialReference.hasRecordedSchedule).toBe(false);
    expect(status?.adjustmentClass).toBe("OUTSIDE_CONTRACT");
    expect((await q<{ plan_id: number | null }>("SELECT plan_id FROM ortho_cases WHERE id=$1", [orthoCaseId]))[0].plan_id).toBeNull();
    const canonical = await listTreatmentFinancialReferences(patientId);
    const selected = canonical?.references.filter(row => row.orthoCaseId === orthoCaseId);
    expect(selected).toHaveLength(1);
    expect(selected?.[0]).toMatchObject({ planItemId: status?.financialReference.sources[0].planItemId,
      clinicalCaseId: status?.financialReference.sources[0].clinicalCaseId, invoiceIds: [billed.invoice.id], packageCoverage: { state: "unspecified" } });
    expect(selected?.[0].unresolvedReasons).not.toContain("financial_review_required");
    expect(await moneyCounts(patientId)).toEqual(before);
    expect(before).toMatchObject({ invoices: 1, payments: 0, installments: 0, repayments: 0 });
    const anotherPatient = await patient();
    expect(await patientLegacyOnboarding(anotherPatient, orthoCaseId)).toBeNull();
  });
});
