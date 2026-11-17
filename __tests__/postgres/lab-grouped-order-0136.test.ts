/** Contract 0136 (docs/review/grouped-lab-order-0136-contract-20261117.md): several crowns entered once on an
 * invoice open ONE lab order; the cost comes from the selected lab's pricing rule and currency; a missing rule and
 * a currency mismatch are explicit states, never a silent conversion. Synthetic data only, on an owned database. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { parseInvoiceCommand, invoiceCommandFingerprint, invoiceCatalogRequestFingerprint } from "../../lib/invoice-template";
import { clinicalLabOrder } from "../../lib/canonical-lab-reads";
import { toLabDispatchExternal } from "../../lib/lab";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";

const target = validatePostgresTestTarget(process.env); stubPostgresEnv();
const db = await import("../../lib/db");
const invoiceWriter = await import("../../lib/invoice-linkage-db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actor: SessionPayload;

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
  const username = `synthetic-grouped-lab-${randomUUID()}`;
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic grouped lab','synthetic-password-hash','admin') RETURNING id", [username]);
  actor = { userId: user.id, username, role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion("synthetic-password-hash") };
  await db.openShift({ openedBy: username, opening: { YER: 100000, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

const TEETH = [14, 15, 24, 25, 26];
type Pricing = { unitMinor: number; currency: string } | null;

/** One crown service mapped in settings to one lab service (owner 6932010630 item 1); one lab with an optional
 * dated price for that lab service. `mapped = false` leaves the clinic service without a lab-service mapping. */
async function world(pricing: Pricing, doctors = 1, mapped = true) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic grouped patient') RETURNING id", [`GLO-${randomUUID()}`]);
  const doctorIds: number[] = [];
  for (let i = 0; i < doctors; i++) doctorIds.push((await q("INSERT INTO parties(name,kind,commission_percent) VALUES($1,'doctor',30) RETURNING id", [`Synthetic grouped doctor ${i} ${randomUUID()}`]))[0].id);
  const [service] = await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,'crown',1000,TRUE,TRUE) RETURNING id", [`Synthetic grouped crown ${randomUUID()}`]);
  const [lab] = await q("INSERT INTO parties(name,kind,currency) VALUES($1,'lab','YER') RETURNING id", [`Synthetic grouped lab ${randomUUID()}`]);
  const [labService] = await q("INSERT INTO lab_services(name,code,category,tooth_scope,requires_shade) VALUES($1,$2,'prostho','single_tooth',TRUE) RETURNING id", [`Synthetic zirconia crown ${randomUUID()}`, `SYN-${randomUUID()}`]);
  if (mapped) await q("UPDATE services SET lab_service_id=$2 WHERE id=$1", [service.id, labService.id]);
  if (pricing) await q("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,$3,$4,'2020-01-01','synthetic')", [lab.id, labService.id, pricing.unitMinor, pricing.currency]);
  return { patientId: patient.id as number, doctorIds, serviceId: service.id as number, labId: lab.id as number, labServiceId: labService.id as number };
}

/** A clinic crown service mapped in settings to the given lab service. */
async function mappedService(labServiceId: number) {
  const [service] = await q("INSERT INTO services(name,category,price_minor,is_active,price_configured,lab_service_id) VALUES($1,'crown',1000,TRUE,TRUE,$2) RETURNING id", [`Synthetic mapped crown ${randomUUID()}`, labServiceId]);
  return service.id as number;
}

/** The short entry: one lab, one shade, optional instructions, for every selected tooth. The lab service is never
 * chosen here: it comes from each line's clinic service mapping. */
function grouped(w: Awaited<ReturnType<typeof world>>, teeth = TEETH, serviceFor: (tooth: number) => number = () => w.serviceId,
  intentId = randomUUID(), memberIds = teeth.map(() => randomUUID())) {
  return teeth.map((tooth, index) => ({
    serviceId: serviceFor(tooth), doctorId: w.doctorIds[index % w.doctorIds.length], quantity: 1, price: "1000", sessions: 1, toothCode: tooth, episodeTeeth: [tooth],
    labWork: { intentId, memberId: memberIds[index], expectedRevision: 0, groupKind: "grouped", instructions: "حواف رفيعة",
      prescription: { partyId: w.labId, shade: "A2", stumpShade: "", toothNumbers: "", dueDate: "2026-12-01", impressionType: "physical", priority: "normal" } },
  }));
}

async function save(w: Awaited<ReturnType<typeof world>>, items: ReturnType<typeof grouped>, idempotencyKey = `glo-${randomUUID()}`) {
  const source = { patientId: w.patientId, currency: "YER", idempotencyKey, items };
  const parsed = parseInvoiceCommand(source, new Map((await db.listServices()).map(s => [s.id, s])), new Set(w.doctorIds), await db.getSettings(), true);
  if (!parsed.ok) throw Error(parsed.message);
  const result = await invoiceWriter.createLinkedInvoice({ patientId: w.patientId, baseCurrency: parsed.baseCurrency, discountMinor: parsed.discountMinor, note: parsed.note,
    existingPlanId: parsed.existingPlanId, items: parsed.items, createdBy: actor.username, actorRole: actor.role, templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey,
    requestHash: invoiceCatalogRequestFingerprint(source, actor), catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session: actor }, auditDetails: {} });
  if (!result.ok) throw Error(result.reason);
  return result;
}
const orders = (patientId: number) => q("SELECT id, cost_minor::int AS cost, cost_currency AS currency, pricing_state, payable_id FROM lab_orders WHERE patient_id=$1", [patientId]);
const payables = (patientId: number) => q("SELECT p.amount_minor::int AS amount, p.currency FROM payables p JOIN lab_orders o ON o.id=p.lab_order_id WHERE o.patient_id=$1", [patientId]);
const report = async (doctorId: number) => (await db.commissionReport("2020-01-01", "2999-12-31")).find(row => row.doctorId === doctorId && row.currency === "YER")!;

describe("0136 grouped lab order from one invoice entry", () => {
  it("keeps each member price append-only on the migrated PostgreSQL schema", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" });
    const result = await save(w, grouped(w));
    const orderId = result.labWork![0].orderId;
    const memberId = result.labWork![0].memberIds[0];

    const trigger = await q(`SELECT t.tgenabled AS enabled, t.tgtype::int AS type,
      t.tgfoid = 'public.aqlan_lab_append_only()'::regprocedure AS expected_function
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='lab_order_member_prices'
        AND t.tgname='lab_order_member_prices_append_only' AND NOT t.tgisinternal`);
    // 27 = row-level, BEFORE, DELETE and UPDATE; O = enabled for ordinary writes.
    expect(trigger).toEqual([{ enabled: "O", type: 27, expected_function: true }]);

    const selectPrice = () => q("SELECT to_jsonb(p) AS price FROM lab_order_member_prices p WHERE lab_order_id=$1 AND member_id=$2", [orderId, memberId]);
    const before = await selectPrice();
    expect(before).toHaveLength(1);
    await expect(q("UPDATE lab_order_member_prices SET unit_cost_minor=unit_cost_minor+1 WHERE lab_order_id=$1 AND member_id=$2", [orderId, memberId]))
      .rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("append-only") });
    expect(await selectPrice()).toEqual(before);
    await expect(q("DELETE FROM lab_order_member_prices WHERE lab_order_id=$1 AND member_id=$2", [orderId, memberId]))
      .rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("append-only") });
    expect(await selectPrice()).toEqual(before);
  });

  it("T1+T3: five crowns open one order with five members, priced 5 × unit in the rule currency, with one payable", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" });
    const result = await save(w, grouped(w));
    expect(result.labWork).toHaveLength(1);
    expect(result.labWork![0]).toMatchObject({ pricing: { state: "rule" } });
    expect(result.labWork![0].memberIds).toHaveLength(5);
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: 1000, currency: "YER", pricing_state: "rule" })]);
    expect(await payables(w.patientId)).toEqual([{ amount: 1000, currency: "YER" }]);
    const linked = await q("SELECT count(DISTINCT invoice_item_id)::int AS n FROM lab_prescription_source_memberships WHERE intent_id=$1 AND invoice_item_id IS NOT NULL", [result.labWork![0].intentId]);
    expect(linked).toEqual([{ n: 5 }]);
    expect(await q("SELECT instructions FROM lab_work_intents WHERE id=$1", [result.labWork![0].intentId])).toEqual([{ instructions: "حواف رفيعة" }]);
  });

  it("T1b: eight teeth from both jaws together open one order with eight members — no split by jaw or by count", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" });
    const bothJaws = [14, 15, 24, 25, 26, 36, 37, 46];
    const key = `glo-jaws-${randomUUID()}`, items = grouped(w, bothJaws);
    const result = await save(w, items, key);
    expect(result.labWork).toHaveLength(1);
    expect(result.labWork![0].memberIds).toHaveLength(8);
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: 1600, currency: "YER", pricing_state: "rule" })]);
    const teeth = await q("SELECT array_agg(tooth_code ORDER BY tooth_code) AS teeth FROM lab_work_members WHERE intent_id=$1 AND retired_revision IS NULL", [result.labWork![0].intentId]);
    expect(teeth).toEqual([{ teeth: bothJaws }]);
    await save(w, items, key);
    expect(await orders(w.patientId)).toHaveLength(1);
    expect(await payables(w.patientId)).toEqual([{ amount: 1600, currency: "YER" }]);
  });

  it("T1c: each tooth keeps its own lab service price; two rule currencies in one order are explicit, never summed", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" });
    const [premium] = await q("INSERT INTO lab_services(name,code,category,tooth_scope,requires_shade) VALUES($1,$2,'prostho','single_tooth',TRUE) RETURNING id", [`Synthetic emax ${randomUUID()}`, `SYN-${randomUUID()}`]);
    await q("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,350,'YER','2020-01-01','synthetic')", [w.labId, premium.id]);
    const premiumCrown = await mappedService(premium.id);
    const priced = await save(w, grouped(w, TEETH, tooth => tooth < 20 ? premiumCrown : w.serviceId)); // 14,15 at 350; 24,25,26 at 200
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: 1300, currency: "YER", pricing_state: "rule" })]);
    expect(await q("SELECT tooth_code, unit_cost_minor::int AS unit, unit_cost_currency AS currency FROM lab_order_member_prices WHERE lab_order_id=$1 ORDER BY tooth_code", [priced.labWork![0].orderId]))
      .toEqual([{ tooth_code: 14, unit: 350, currency: "YER" }, { tooth_code: 15, unit: 350, currency: "YER" }, { tooth_code: 24, unit: 200, currency: "YER" }, { tooth_code: 25, unit: 200, currency: "YER" }, { tooth_code: 26, unit: 200, currency: "YER" }]);

    const mixed = await world({ unitMinor: 200, currency: "YER" });
    const [foreign] = await q("INSERT INTO lab_services(name,code,category,tooth_scope,requires_shade) VALUES($1,$2,'prostho','single_tooth',TRUE) RETURNING id", [`Synthetic imported ${randomUUID()}`, `SYN-${randomUUID()}`]);
    await q("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,50,'SAR','2020-01-01','synthetic')", [mixed.labId, foreign.id]);
    const importedCrown = await mappedService(foreign.id);
    const result = await save(mixed, grouped(mixed, TEETH, tooth => tooth === 14 ? importedCrown : mixed.serviceId));
    expect(result.labWork).toHaveLength(1);
    expect(result.labWork![0]).toMatchObject({ pricing: { state: "mixed_currency" } });
    expect(await orders(mixed.patientId)).toEqual([expect.objectContaining({ cost: null, pricing_state: "mixed_currency", payable_id: null })]);
    expect(await payables(mixed.patientId)).toEqual([]);
    // Owner 6932010630 item 3: shown in their own currencies, never summed or converted.
    expect(await q("SELECT tooth_code, unit_cost_minor::int AS unit, unit_cost_currency AS currency FROM lab_order_member_prices WHERE lab_order_id=$1 ORDER BY tooth_code", [result.labWork![0].orderId]))
      .toEqual([{ tooth_code: 14, unit: 50, currency: "SAR" }, ...[15, 24, 25, 26].map(tooth_code => ({ tooth_code, unit: 200, currency: "YER" }))]);
  });

  it("T2+T9: saving again with the same key (a lost response) returns the same receipt and adds no order or payable", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" });
    const items = grouped(w), key = `glo-replay-${randomUUID()}`;
    const first = await save(w, items, key), again = await save(w, items, key);
    expect(again.labWork).toEqual(first.labWork);
    expect(await orders(w.patientId)).toHaveLength(1);
    expect(await payables(w.patientId)).toHaveLength(1);
  });

  it("T4: each doctor's commission deducts only the unit cost of that doctor's own teeth", async () => {
    const one = await world({ unitMinor: 200, currency: "YER" });
    await save(one, grouped(one));
    expect(await report(one.doctorIds[0])).toMatchObject({ accruedMinor: 1200, labCostMinor: 1000 }); // (5000 − 1000) × 30%
    const two = await world({ unitMinor: 200, currency: "YER" }, 2);
    await save(two, grouped(two)); // teeth 0,2,4 → doctor 0; teeth 1,3 → doctor 1
    expect(await report(two.doctorIds[0])).toMatchObject({ accruedMinor: 720, labCostMinor: 600 }); // (3000 − 600) × 30%
    expect(await report(two.doctorIds[1])).toMatchObject({ accruedMinor: 480, labCostMinor: 400 }); // (2000 − 400) × 30%
  });

  it("T5: no pricing rule ⇒ one unpriced order marked missing_rule, no payable, commission on the full amount", async () => {
    const w = await world(null);
    const result = await save(w, grouped(w));
    expect(result.labWork![0]).toMatchObject({ pricing: { state: "missing_rule" } });
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: null, pricing_state: "missing_rule", payable_id: null })]);
    expect(await payables(w.patientId)).toEqual([]);
    expect(await report(w.doctorIds[0])).toMatchObject({ accruedMinor: 1500, labCostMinor: 0 });
  });

  it("T5b: entering the missing price later makes one payable; saving the invoice again duplicates nothing and keeps the entered cost", async () => {
    const w = await world(null);
    const items = grouped(w), key = `glo-late-${randomUUID()}`;
    const result = await save(w, items, key);
    const orderId = result.labWork![0].orderId;
    await db.updateLabOrderAccounting(orderId, { costMinor: 900, costCurrency: "YER", exchangeRate: 1, actor: actor.username, actorRole: actor.role });
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: 900, currency: "YER", pricing_state: "manual" })]);
    await save(w, items, key);
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: 900, pricing_state: "manual" })]);
    expect(await payables(w.patientId)).toEqual([{ amount: 900, currency: "YER" }]);
  });

  it("T5c: a clinic service without a lab-service mapping saves the invoice with one pending order, never a computed zero", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" }, 1, false);
    const result = await save(w, grouped(w));
    expect(result.invoice.id).toBeGreaterThan(0);
    expect(result.labWork![0]).toMatchObject({ pricing: { state: "missing_mapping" } });
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: null, pricing_state: "missing_mapping", payable_id: null })]);
    expect(await payables(w.patientId)).toEqual([]);
  });

  it("T5d: a grouped entry saved before a lab is chosen keeps one pending order (missing_rule), never a guessed lab", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" });
    const items = grouped(w).map(item => ({ ...item, labWork: { ...item.labWork, prescription: { ...item.labWork.prescription, partyId: null as unknown as number } } }));
    const result = await save(w, items);
    expect(result.labWork![0]).toMatchObject({ pricing: { state: "missing_rule" } });
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: null, pricing_state: "missing_rule", payable_id: null })]);
    expect(await payables(w.patientId)).toEqual([]);
  });

  it("T6: a rule in another currency is never converted: the cost stays pending, each tooth keeps its price in that currency, no payable", async () => {
    const w = await world({ unitMinor: 50, currency: "SAR" });
    const result = await save(w, grouped(w));
    expect(result.labWork![0]).toMatchObject({ pricing: { state: "currency_mismatch" } });
    expect(await orders(w.patientId)).toEqual([expect.objectContaining({ cost: null, pricing_state: "currency_mismatch", payable_id: null })]);
    expect(await payables(w.patientId)).toEqual([]);
    expect(await q("SELECT DISTINCT unit_cost_minor::int AS unit, unit_cost_currency AS currency FROM lab_order_member_prices WHERE lab_order_id=$1", [result.labWork![0].orderId]))
      .toEqual([{ unit: 50, currency: "SAR" }]);
    expect(await report(w.doctorIds[0])).toMatchObject({ accruedMinor: 1500, labCostMinor: 0 });
  });

  it("manual total never weights different currencies; authorized read preserves each price and dispatch excludes private fields", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" }, 2);
    const [foreign] = await q("INSERT INTO lab_services(name,code,category,tooth_scope,requires_shade) VALUES($1,$2,'prostho','single_tooth',TRUE) RETURNING id", [`Synthetic foreign ${randomUUID()}`, `SYN-${randomUUID()}`]);
    await q("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,50,'SAR','2020-01-01','synthetic')", [w.labId, foreign.id]);
    const service = await mappedService(foreign.id);
    const saved = await save(w, grouped(w, [14, 36], tooth => tooth === 14 ? service : w.serviceId));
    await db.updateLabOrderAccounting(saved.labWork![0].orderId, { costMinor: 900, costCurrency: "YER", exchangeRate: 1, actor: actor.username, actorRole: actor.role });
    for (const doctor of w.doctorIds) expect(await report(doctor)).toMatchObject({ labCostMinor: 0, labCostNotDeductedCount: 1 });
    expect(await payables(w.patientId)).toEqual([{ amount: 900, currency: "YER" }]);
    const [order] = await db.listLabOrders({ patientId: w.patientId });
    expect(order.members?.map(m => m.toothCode)).toEqual([14, 36]);
    expect(order.memberPrices).toEqual([expect.objectContaining({ unitCostMinor: 50, currency: "SAR" }), expect.objectContaining({ unitCostMinor: 200, currency: "YER" })]);
    const clinical = clinicalLabOrder(order);
    expect(clinical.members).toEqual(order.members);
    expect(clinical).not.toHaveProperty("memberPrices");
    const dispatch = toLabDispatchExternal({ ...order, details: "SYNTHETIC-PRIVATE-NOTE", note: "SYNTHETIC-PRIVATE-NOTE" });
    expect(JSON.stringify(dispatch)).not.toContain("SYNTHETIC-PRIVATE-NOTE");
    expect(dispatch).not.toHaveProperty("memberPrices");
    expect(dispatch).not.toHaveProperty("members");
  });

  it("a manual total for one doctor needs no comparison of foreign tooth prices", async () => {
    const w = await world({ unitMinor: 50, currency: "SAR" });
    const result = await save(w, grouped(w));
    await db.updateLabOrderAccounting(result.labWork![0].orderId, { costMinor: 900, costCurrency: "YER", exchangeRate: 1, actor: actor.username, actorRole: actor.role });
    expect(await report(w.doctorIds[0])).toMatchObject({ accruedMinor: 1230, labCostMinor: 900, labCostNotDeductedCount: 0 });
  });

  it("concurrent identical submissions commit one invoice, one order and one payable", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" }, 2);
    const items = grouped(w), key = `glo-race-${randomUUID()}`;
    const results = await Promise.all([save(w, items, key), save(w, items, key)]);
    const replay = await save(w, items, key);
    for (const result of results) expect(result.invoice.id).toBe(replay.invoice.id);
    expect(await orders(w.patientId)).toHaveLength(1);
    expect(await payables(w.patientId)).toHaveLength(1);
    expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [w.patientId])).toHaveLength(1);
  });

  it("T11: a grouped entry refuses a member with more than one unit and writes nothing", async () => {
    const w = await world({ unitMinor: 200, currency: "YER" });
    const items = grouped(w); items[0] = { ...items[0], quantity: 2 };
    await expect(save(w, items)).rejects.toThrow();
    expect(await orders(w.patientId)).toEqual([]);
  });
});
