/** M2 slice 88: the canonical patient account (GET ledger, statement, treatment-financial-context,
 * legacy-balance-arrangement, debt-repayments; GET /api/finance/debts) on real PostgreSQL,
 * synthetic data only. Each read equals the legacy body over the same rows. finance.patient-ledger.view inside the patient scope;
 * the legacy body computed by the same builder; the legacy role-label controls become
 * grants (receipt correction finance.payments.void, openings finance.opening-balances.manage,
 * legacy arrangements finance.legacy.record); refused without the grant (clinical grants
 * and finance.invoices.view never substitute); outside reads like missing; revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-patient-ledger-secret-88");
const db = await import("../../lib/db");
const account = await import("../../lib/canonical-patient-account");
const { buildPatientLedgerPayload } = await import("../../lib/patient-ledger-payload");
const { clinicDateString } = await import("../../lib/schedule");
const { loadPatientStatementDocument } = await import("../../lib/patient-statement-build");
const { listTreatmentFinancialReferences } = await import("../../lib/treatment-financial-context-db");
const { debtRepaymentWorkspace } = await import("../../lib/debt-installments-db");
const { listLegacyBalanceArrangements } = await import("../../lib/legacy-balance-arrangements-db");

const LEDGER = { "finance.patient-ledger.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PL-OWNER", role: "admin" },
  reader: { username: "SYN-PL-READ", role: "reception", patientScope: "all", grants: LEDGER },
  corrector: { username: "SYN-PL-VOID", role: "reception", patientScope: "all", grants: { ...LEDGER, "finance.payments.view": true, "finance.payments.void": true } },
  opener: { username: "SYN-PL-OPEN", role: "reception", patientScope: "all", grants: { ...LEDGER, "finance.opening-balances.manage": true } },
  recorder: { username: "SYN-PL-LEGACY", role: "reception", patientScope: "all", grants: { ...LEDGER, "finance.legacy.record": true } },
  doctor: { username: "SYN-PL-DR", role: "doctor", doctor: true, patientScope: "own", grants: LEDGER },
  clinician: { username: "SYN-PL-CLIN", role: "doctor", doctor: true, patientScope: "all", grants: { "clinical.visits.document": true, "finance.invoices.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string }) => error);
const ids = { mine: 0, other: 0 };

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,$2,$3) RETURNING id", [number, `SYN PL ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-PL-1", fx.parties.doctor!);
  ids.other = await patient("SYN-PL-2", null);
  for (const [id, amount] of [[ids.mine, 77700], [ids.other, 55500]]) {
    await q("INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date, currency, note, created_by) VALUES ($1, $2, '2026-01-01', 'YER', 'SYN opening', 'SYN')", [id, amount]);
  }
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("patient account", () => {
  it("the body equals the shared builder over the same rows; the opening balance counts", async () => {
    const read = await account.readCanonicalPatientLedger(await fx.session("reader"), ids.mine);
    const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
    const { invoices, payments, openings } = await db.patientLedger(ids.mine);
    const expected = buildPatientLedgerPayload({ patientId: ids.mine, invoices, payments, openings, plans: await db.listPatientPlans(ids.mine, today) });
    expect(JSON.parse(JSON.stringify(read))).toMatchObject(JSON.parse(JSON.stringify(expected)));
    expect(read.openings).toEqual([expect.objectContaining({ currency: "YER", amountMinor: 77700 })]);
    expect(read).toMatchObject({ clinicTimeZone: db.CLINIC_TIME_ZONE, legacyBalanceArrangements: [], installmentRecovery: expect.any(Object) });
  });

  it("controls follow grants, never role labels", async () => {
    const reader = await account.readCanonicalPatientLedger(await fx.session("reader"), ids.mine);
    expect(reader).not.toHaveProperty("receiptRemaining");
    expect(reader).toMatchObject({ openingAccess: { add: false, edit: false }, legacyArrangementAccess: { manage: false } });
    expect(await account.readCanonicalPatientLedger(await fx.session("corrector"), ids.mine)).toHaveProperty("receiptRemaining");
    expect(await account.readCanonicalPatientLedger(await fx.session("opener"), ids.mine)).toMatchObject({ openingAccess: { add: true, edit: true } });
    expect(await account.readCanonicalPatientLedger(await fx.session("recorder"), ids.mine)).toMatchObject({ legacyArrangementAccess: { manage: true } });
    expect(await account.readCanonicalPatientLedger(await fx.session("owner"), ids.mine)).toMatchObject({
      receiptRemaining: expect.any(Object), openingAccess: { add: true, edit: true }, legacyArrangementAccess: { manage: true } });
  });

  it("refused without the ledger grant (the invoice view and clinical grants never substitute); outside reads like missing; revocation", async () => {
    expect(await refusal(account.readCanonicalPatientLedger(await fx.session("clinician"), ids.mine))).toMatchObject({ message: expect.stringMatching(/CAPABILITY_DENIED$/) });
    expect(await account.readCanonicalPatientLedger(await fx.session("doctor"), ids.mine)).toHaveProperty("balances");
    expect(await refusal(account.readCanonicalPatientLedger(await fx.session("doctor"), ids.other))).toMatchObject({ code: "patient_not_found" });
    expect(await refusal(account.readCanonicalPatientLedger(await fx.session("reader"), 2147483000))).toMatchObject({ code: "patient_not_found" });
    await fx.setGrants("reader", { "clinical.visits.document": true }, { patientScope: "all" });
    try {
      expect(await refusal(account.readCanonicalPatientLedger(await fx.session("reader"), ids.mine))).toMatchObject({ message: expect.stringMatching(/CAPABILITY_DENIED$/) });
    } finally { await fx.setGrants("reader", LEDGER, { patientScope: "all" }); }
  });
});

describe("the other account reads", () => {
  const today = () => clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
  const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };

  it("statement, treatment references, arrangements and the repayment workspace equal the legacy bodies", async () => {
    const reader = await fx.session("reader");
    for (const options of [{ type: "detailed" }, { type: "summary" }] as const) {
      const read = await account.readCanonicalPatientStatement(reader, ids.mine, options as never) as { sections: unknown; notices: unknown };
      const legacy = await loadPatientStatementDocument(ids.mine, options as never) as { sections: unknown; notices: unknown };
      expect(read.sections).toEqual(legacy.sections);
      expect(read.notices).toEqual(legacy.notices);
    }
    expect(await account.readCanonicalTreatmentFinancialContext(reader, ids.mine)).toEqual(await listTreatmentFinancialReferences(ids.mine));
    expect(await account.readCanonicalDebtRepaymentWorkspace(reader, ids.mine)).toEqual(await debtRepaymentWorkspace(ids.mine, today()));
    expect(await account.readCanonicalLegacyBalanceArrangements(reader, ids.mine)).toEqual({ arrangements: await listLegacyBalanceArrangements(ids.mine, today()), canManage: false });
    expect(await account.readCanonicalLegacyBalanceArrangements(await fx.session("recorder"), ids.mine)).toMatchObject({ canManage: true });
  });

  it("the debtors list keeps rows inside the patient scope; the cap and base currency as legacy", async () => {
    const all = await account.readCanonicalPatientDebts(await fx.session("reader"));
    expect(all.baseCurrency).toBe("YER");
    const legacy = (await db.patientDebtReport()).filter(row => row.patientId === ids.mine || row.patientId === ids.other);
    expect(all.rows.filter(row => row.patientId === ids.mine || row.patientId === ids.other)).toEqual(legacy);
    const own = await account.readCanonicalPatientDebts(await fx.session("doctor"));
    expect(own.rows.map(row => row.patientId)).toEqual([ids.mine]);
    expect(JSON.stringify(own)).not.toContain("SYN PL SYN-PL-2");
  });

  it("every read refuses without the ledger grant; outside the scope reads like missing; revocation", async () => {
    const clinician = await fx.session("clinician");
    for (const read of [
      () => account.readCanonicalPatientStatement(clinician, ids.mine, { type: "detailed" } as never),
      () => account.readCanonicalTreatmentFinancialContext(clinician, ids.mine),
      () => account.readCanonicalDebtRepaymentWorkspace(clinician, ids.mine),
      () => account.readCanonicalLegacyBalanceArrangements(clinician, ids.mine),
      () => account.readCanonicalPatientDebts(clinician),
    ]) expect(await refusal(read())).toMatchObject(denied);
    const doctor = await fx.session("doctor");
    for (const read of [
      () => account.readCanonicalPatientStatement(doctor, ids.other, { type: "detailed" } as never),
      () => account.readCanonicalTreatmentFinancialContext(doctor, ids.other),
      () => account.readCanonicalDebtRepaymentWorkspace(doctor, ids.other),
      () => account.readCanonicalLegacyBalanceArrangements(doctor, ids.other),
    ]) expect(await refusal(read())).toMatchObject({ code: "patient_not_found" });
    await fx.setGrants("reader", { "finance.invoices.view": true }, { patientScope: "all" });
    try {
      expect(await refusal(account.readCanonicalPatientDebts(await fx.session("reader")))).toMatchObject(denied);
      expect(await refusal(account.readCanonicalPatientStatement(await fx.session("reader"), ids.mine, { type: "summary" } as never))).toMatchObject(denied);
    } finally { await fx.setGrants("reader", LEDGER, { patientScope: "all" }); }
  });
});

