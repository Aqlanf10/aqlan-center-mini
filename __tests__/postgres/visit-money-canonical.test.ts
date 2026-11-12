/** M2 slice 89: the visit's money reads on the canonical runtime, real PostgreSQL, synthetic
 * data only. Walkout: finance.invoices.view admits; payments, account and derived dues by
 * their own grants; the owner's body equals the legacy reader's. Billing preview: the legacy
 * body under the invoice view. Financial context: documenters see coverage without source
 * references. Outside the scope reads like missing; ledger/clinical grants never substitute;
 * revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-visit-money-secret-89");
const db = await import("../../lib/db");
const money = await import("../../lib/canonical-visit-money");
const { readVisitCheckout } = await import("../../lib/checkout-db");
const { getVisitFinancialContext } = await import("../../lib/visit-financial-context-db");
const { redactVisitFinancialContext } = await import("../../lib/visit-financial-context");

const INV = { "finance.invoices.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-VM-OWNER", role: "admin" },
  dues: { username: "SYN-VM-DUES", role: "reception", patientScope: "all", grants: INV },
  full: { username: "SYN-VM-FULL", role: "reception", patientScope: "all", grants: { ...INV, "finance.payments.view": true, "finance.patient-ledger.view": true } },
  ledger: { username: "SYN-VM-LEDGER", role: "accountant", patientScope: "all", grants: { "finance.patient-ledger.view": true, "finance.payments.view": true } },
  documenter: { username: "SYN-VM-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.visits.document": true } },
  ownDues: { username: "SYN-VM-OWNDUES", role: "doctor", doctor: true, patientScope: "own", grants: INV },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const ids = { patient: 0, other: 0, visit: 0, otherVisit: 0 };

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  await db.openShift({ openedBy: "SYN-VM-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
  ids.patient = (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ('SYN-VM-1','SYN VM patient',$1) RETURNING id", [fx.parties.ownDues]))[0].id;
  ids.other = (await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-VM-2','SYN VM other') RETURNING id"))[0].id;
  await q("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.ownDues, ids.patient]);
  const invoice = (await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES('SYN-VM-INV',$1,'YER',30000,0,'SYN') RETURNING id", [ids.patient]))[0].id;
  ids.visit = (await q("INSERT INTO visits(patient_name,patient_id,doctor_id,invoice_id,signed_at) VALUES('SYN VM',$1,$2,$3,now()) RETURNING id", [ids.patient, fx.parties.ownDues, invoice]))[0].id;
  ids.otherVisit = (await q("INSERT INTO visits(patient_name,patient_id) VALUES('SYN VM other',$1) RETURNING id", [ids.other]))[0].id;
  const paid = await db.recordPayment({ patientId: ids.patient, invoiceId: invoice, openingCurrency: null, amountMinor: 12000, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, kind: "payment", method: "cash", note: null, createdBy: "SYN", idempotencyKey: "syn-vm-pay-1" });
  expect(paid.reason).toBeNull();
}, 180_000);
afterAll(async () => { await fx?.close(); });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("walkout", () => {
  it("the owner's body carries every legacy value; dues-only omits payments, account and derived dues", async () => {
    const owner = await money.readCanonicalVisitWalkout(await fx.session("owner"), String(ids.visit)) as Record<string, unknown>;
    const legacy = (await readVisitCheckout(ids.visit))!;
    expect(owner).toMatchObject(json({ invoice: legacy.walkout.invoice, payments: legacy.walkout.payments, balances: legacy.walkout.balances,
      summary: legacy.summary, checkout: legacy.walkout.checkout }));
    const dues = await money.readCanonicalVisitWalkout(await fx.session("dues"), String(ids.visit)) as Record<string, unknown>;
    expect(dues).toMatchObject({ invoice: { netMinor: 30000 } });
    for (const hidden of ["payments", "balances", "dueRecommendation"]) expect(dues).not.toHaveProperty(hidden);
    expect(JSON.stringify(dues)).not.toContain("12000");
    const full = await money.readCanonicalVisitWalkout(await fx.session("full"), String(ids.visit)) as { dueRecommendation?: { collectionAction: string } };
    expect(full).toHaveProperty("payments");
    expect(full.dueRecommendation?.collectionAction ?? "none").toBe("none");
  });

  it("refused without the invoice view (ledger and payments grants never substitute); outside reads like missing; revocation", async () => {
    expect(await refusal(money.readCanonicalVisitWalkout(await fx.session("ledger"), String(ids.visit)))).toMatchObject(denied);
    expect(await refusal(money.readCanonicalVisitWalkout(await fx.session("ownDues"), String(ids.otherVisit)))).toMatchObject({ code: "patient_not_found" });
    expect(await money.readCanonicalVisitWalkout(await fx.session("ownDues"), String(ids.visit))).toHaveProperty("invoice");
    await fx.setGrants("dues", { "finance.patient-ledger.view": true }, { patientScope: "all" });
    try {
      expect(await refusal(money.readCanonicalVisitWalkout(await fx.session("dues"), String(ids.visit)))).toMatchObject(denied);
    } finally { await fx.setGrants("dues", INV, { patientScope: "all" }); }
  });
});

describe("billing preview and financial context", () => {
  it("the preview is the legacy body under the invoice view; refused to the ledger grant", async () => {
    expect(json(await money.readCanonicalVisitBillingPreview(await fx.session("dues"), String(ids.visit)))).toEqual(json(await db.previewVisitBilling(ids.visit)));
    expect(await refusal(money.readCanonicalVisitBillingPreview(await fx.session("ledger"), String(ids.visit)))).toMatchObject(denied);
  });

  it("documenters see coverage without references; the invoice view sees them; the ledger alone is refused", async () => {
    const legacy = (await getVisitFinancialContext(ids.visit, ids.patient))!;
    expect(json(await money.readCanonicalVisitFinancialContext(await fx.session("ownDues"), String(ids.visit)))).toEqual(json(redactVisitFinancialContext(legacy, true)));
    // The documenter's own visit (it is the visit's clinician; "own" scope).
    const mine = (await q("INSERT INTO visits(patient_name,patient_id,doctor_id) VALUES('SYN VM doc',$1,$2) RETURNING id", [ids.patient, fx.parties.documenter]))[0].id as number;
    const legacyMine = (await getVisitFinancialContext(mine, ids.patient))!;
    expect(json(await money.readCanonicalVisitFinancialContext(await fx.session("documenter"), String(mine)))).toEqual(json(redactVisitFinancialContext(legacyMine, false)));
    // Its visit links the patient into its scope (the list predicate), so the outside case uses another patient.
    expect(await refusal(money.readCanonicalVisitFinancialContext(await fx.session("ledger"), String(ids.visit)))).toMatchObject(denied);
    expect(await refusal(money.readCanonicalVisitFinancialContext(await fx.session("documenter"), String(ids.otherVisit)))).toMatchObject({ code: "patient_not_found" });
  });
});
