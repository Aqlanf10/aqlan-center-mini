import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { parseInvoiceCommand, invoiceCommandFingerprint, invoiceCatalogRequestFingerprint } from "../../lib/invoice-template";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import type { LabWorkDraft } from "../../lib/lab-work-intent-contract";
const target = validatePostgresTestTarget(process.env); stubPostgresEnv();
const db = await import("../../lib/db");
const invoiceWriter = await import("../../lib/invoice-linkage-db");
const revision = await import("../../lib/invoice-revision-db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actor: SessionPayload;
beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
  const username = `synthetic-lab-acceptance-${randomUUID()}`;
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic lab commission','synthetic-password-hash','admin') RETURNING id", [username]);
  actor = { userId: user.id, username, role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion("synthetic-password-hash") };
  await db.openShift({ openedBy: username, opening: { YER: 100000, SAR: 0, USD: 0 } });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(grouped = false, withCost = true, deductLabCost: boolean | null = null) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic lab cost patient') RETURNING id", [`LCC-${randomUUID()}`]);
  const [doctor] = await q("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic lab cost doctor','doctor',30) RETURNING id");
  if (deductLabCost !== null) {
    // The policy is the doctor's own dated commission configuration; effective from a fixed synthetic date.
    const config = { calculationMode: "percentage", defaultPercent: 30, categoryRates: {}, fixedAmountPerVisitMinor: 0,
      deductLabCost, deductMaterialCost: false, basis: "invoiced", effectiveDate: "2020-01-01", rateHistory: [] };
    await q("INSERT INTO users(username,display_name,password_hash,role,party_id,commission_config) VALUES($1,'Synthetic policy doctor','synthetic-password-hash','doctor',$2,$3)",
      [`synthetic-policy-doctor-${randomUUID()}`, doctor.id, JSON.stringify(config)]);
  }
  const [service] = await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,$2,1000,TRUE,TRUE) RETURNING id", [`Synthetic cost service ${randomUUID()}`, grouped ? "bridge" : "crown"]);
  const [lab] = await q("INSERT INTO parties(name,kind,currency) VALUES('Synthetic commission lab','lab','YER') RETURNING id");
  const intentId = randomUUID();
  const items = (grouped ? [27, 28] : [27]).map(tooth => {
    const labWork: LabWorkDraft = { intentId, memberId: randomUUID(), expectedRevision: 0, groupKind: grouped ? "bridge" : "single", prescription: { partyId: lab.id, shade: "", stumpShade: "", toothNumbers: "", dueDate: "2026-11-01", impressionType: "physical", priority: "normal" } };
    return { serviceId: service.id, doctorId: doctor.id, quantity: 1, price: "1000", sessions: 1, toothCode: tooth, episodeTeeth: [tooth], labWork };
  });
  const source = { patientId: patient.id, currency: "YER", idempotencyKey: `lcc-${randomUUID()}`, items };
  const parsed = parseInvoiceCommand(source, new Map((await db.listServices()).map(s => [s.id, s])), new Set([doctor.id]), await db.getSettings(), true);
  if (!parsed.ok) throw Error(parsed.message);
  const result = await invoiceWriter.createLinkedInvoice({ patientId: patient.id, baseCurrency: parsed.baseCurrency, discountMinor: parsed.discountMinor, note: parsed.note, existingPlanId: parsed.existingPlanId, items: parsed.items, createdBy: actor.username, actorRole: actor.role, templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: source.idempotencyKey, requestHash: invoiceCatalogRequestFingerprint(source, actor), catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session: actor }, auditDetails: {} });
  if (!result.ok) throw Error(result.reason);
  const orderId = result.labWork![0].orderId;
  if (withCost) await db.updateLabOrderAccounting(orderId, { costMinor: 200, costCurrency: "YER", exchangeRate: 1, actor: actor.username, actorRole: actor.role });
  return { patientId: patient.id as number, doctorId: doctor.id as number, invoice: result.invoice, orderId, intentId };
}
async function report(doctorId: number) { return (await db.commissionReport("2020-01-01", "2999-12-31")).find(row => row.doctorId === doctorId && row.currency === "YER")!; }
const payables = (orderId: number) => q("SELECT amount_minor::int AS amount, currency FROM payables WHERE lab_order_id=$1", [orderId]);

/** Owner acceptance #483 6886062729 item 3: invoice 1000, lab cost 200, doctor 30%. Synthetic data only. */
describe("crown invoice → lab cost → doctor commission, with the lab-deduction policy on and off", () => {
  it("policy on: the commission base is 800 and the accrual 240; the lab payable is one row of 200", async () => {
    const f = await fixture(false, true, true);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, labCostMinor: 200, labCostNotDeductedCount: 0 });
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
  });
  it("policy off: the base is 1000 and the accrual 300; the same single lab payable of 200 remains", async () => {
    const f = await fixture(false, true, false);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 300 });
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
  });
  it("an unpriced sent order is not a payable and deducts nothing until the cost is entered once", async () => {
    const f = await fixture(false, false, true);
    expect(await payables(f.orderId)).toEqual([]);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 300 });
    await db.updateLabOrderAccounting(f.orderId, { costMinor: 200, costCurrency: "YER", exchangeRate: 1, actor: actor.username, actorRole: actor.role });
    expect(await payables(f.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
    expect(await report(f.doctorId)).toMatchObject({ accruedMinor: 240, labCostMinor: 200 });
  });
});
