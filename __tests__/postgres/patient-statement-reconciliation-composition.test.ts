import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_statement_reconciliation_composition");
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const reconciliation = await import("../../lib/agreement-reconciliation-db");
const { projectPatientStatement } = await import("../../lib/patient-statement-projection");
const { assemblePatientStatement, planPosition, statementDueNowByCurrency } = await import("../../lib/patient-statement-build");
const { SETTING_DEFAULTS } = await import("../../lib/settings");
const { CURRENCIES, formatMoney } = await import("../../lib/money");
const { clinicDateString } = await import("../../lib/schedule");
const query = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let session: SessionPayload;

beforeAll(async () => {
  // Exercise the registered current runtime migrations, including reconciliation,
  // against only this test's isolated synthetic database (no shared schema reset).
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-statement-reconciliation-only");
  const [actor] = await query("INSERT INTO users(username,display_name,password_hash,role) VALUES('statement-reconcile','Synthetic statement reconciliation',$1,'admin') RETURNING id", [hash]);
  session = { userId: actor.id, username: "statement-reconcile", role: "admin", credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3600000 };
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
});
afterAll(async () => db.resetPoolForTesting());

it.each(CURRENCIES)("composes reconciled %s principal once, retains completed debt, and withholds unverified due-now", async currency => {
  const [patient] = await query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic statement reconciliation') RETURNING id", [`STATEMENT-RECON-${currency}`]);
  const [doctor] = await query("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic reconciliation doctor','doctor',30) RETURNING id");
  await query("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source,reason,recorded_by) VALUES($1,30,NULL,'2020-01-01','baseline','Synthetic known policy','statement-reconcile')", [doctor.id]);
  const made = await db.createPlanV2({ patientId: patient.id, title: `Synthetic reconciled ${currency}`, specialty: null, primaryDoctorId: doctor.id,
    billingMode: "installments", baseCurrency: currency, startDate: "2026-10-01", note: null, createdBy: session.username, items: [],
    installments: [{ dueDate: "2026-10-01", amountMinor: 12000 }, { dueDate: "2026-11-01", amountMinor: 168000 }] });
  if (!made.ok) throw new Error(made.message);
  await db.recordPlanConsent({ planId: made.planId, actor: session.username, note: null });
  const paid = await db.recordPlanInstallment({ planId: made.planId, patientId: patient.id, installmentNumber: 1, planTitle: `Synthetic reconciled ${currency}`,
    amountMinor: 12000, currency, baseCurrency: "YER", exchangeRate: currency === "YER" ? 1 : currency === "SAR" ? 140 : 530,
    method: "cash", note: null, createdBy: session.username, actorRole: "admin", idempotencyKey: `statement-recon-payment-${currency}` });
  if ("reason" in paid) throw new Error(paid.reason);
  await query("UPDATE treatment_plans SET status='completed' WHERE id=$1", [made.planId]);
  const preview = await reconciliation.readAgreementReconciliation(made.planId, session);
  expect(preview).toMatchObject({ canConfirm: true, amounts: { agreedMinor: 180000, billedPrincipalMinor: 12000, unbilledPrincipalMinor: 168000, paidMinor: 12000, remainingMinor: 168000 } });
  await reconciliation.saveAgreementReconciliation(made.planId, { operationKey: `statement-recon-confirm-${currency}`, expectedSourceHash: preview.sourceHash, reason: "Synthetic patient statement composition" }, session);

  const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
  const snapshot = await db.patientStatementSnapshot(patient.id, today, { patientFacing: true, historicalAgreements: true });
  const projected = projectPatientStatement({ patientId: patient.id, ledger: snapshot.ledger, planCurrencies: snapshot.planCurrencies, evidence: snapshot.statementEvidence! });
  expect(projected.balances).toEqual(db.ledgerBalancesByCurrency(patient.id, snapshot.ledger, snapshot.planCurrencies));
  expect(projected.balances[currency]).toEqual({ billedMinor: 180000, collectedMinor: 12000, openingMinor: 0, dueMinor: 168000 });
  expect(projected.invoices.reduce((sum, invoice) => sum + invoice.netMinor, 0)).toBe(180000);
  expect(projected.payments).toHaveLength(1);
  for (const other of CURRENCIES.filter(value => value !== currency)) expect(projected.balances[other].dueMinor).toBe(0);
  const plan = snapshot.plans.find(candidate => candidate.id === made.planId)!;
  expect(plan).toMatchObject({ status: "completed", debtSource: "invoice", invoiceFinancial: { kind: "invoice_backed", schedules: [] } });
  expect(planPosition(plan, today)).toEqual({ total: 180000, paid: 12000, remaining: 168000, due: null });
  expect(statementDueNowByCurrency(snapshot, projected, today)[currency]).toBeNull();

  const patientView = { fullName: "Synthetic statement reconciliation", patientNumber: `STATEMENT-RECON-${currency}`, phone: null };
  const summary = assemblePatientStatement(patientView, SETTING_DEFAULTS, snapshot, projected, { type: "summary" }, "synthetic", today);
  const currencyIndex = CURRENCIES.indexOf(currency);
  expect(summary.sections.find(section => section.title === "ملخص الحساب حسب العملة")!.rows[currencyIndex].slice(1)).toEqual([
    formatMoney(180000, currency), formatMoney(0, currency), formatMoney(12000, currency), formatMoney(168000, currency),
  ]);
  expect(summary.sections.find(section => section.title === "المستحق الآن حسب العملة")!.rows[currencyIndex][1]).toBe("غير متاح");
  const ongoing = assemblePatientStatement(patientView, SETTING_DEFAULTS, snapshot, projected, { type: "ongoing" }, "synthetic", today);
  expect(ongoing.sections.find(section => section.title === "العلاج الجاري")!.rows).toEqual([]);
  expect(ongoing.sections.find(section => section.title === "علاج منتهٍ سريريًا وبقيت عليه مديونية")!.rows).toEqual([
    [plan.title, expect.any(String), formatMoney(180000, currency), formatMoney(12000, currency), formatMoney(168000, currency), "غير متاح"],
  ]);
});
