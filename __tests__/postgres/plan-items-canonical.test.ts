/** M2 slice 94c (G4-1, G4-8; contract section 11): plan items and consent on the canonical runtime,
 * real PostgreSQL, synthetic data only. clinical.plans.edit inside the patient scope; the item price
 * on an agreement-currency plan by the price grants; the item audits in the transaction; update and
 * delete with their legacy guards; consent with its schedule, a schedule refusal keeping the consent;
 * view grants, price grants alone and labels never write; outside reads like missing, decided after
 * the writer's patient and plan locks (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-plan-items-secret-94c");
const db = await import("../../lib/db");
const items = await import("../../lib/canonical-plan-items");

const EDIT = { "clinical.plans.edit": true, "clinical.plans.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PI-OWNER", role: "admin" },
  editor: { username: "SYN-PI-EDIT", role: "reception", patientScope: "all", grants: EDIT },
  discounter: { username: "SYN-PI-DISC", role: "reception", patientScope: "all", grants: { ...EDIT, "finance.discounts.apply": true } },
  overrider: { username: "SYN-PI-OVER", role: "reception", patientScope: "all", grants: { ...EDIT, "finance.discounts.apply": true, "finance.discounts.override": true } },
  raiser: { username: "SYN-PI-RAISE", role: "reception", patientScope: "all", grants: { ...EDIT, "finance.price-increases.apply": true } },
  pricer: { username: "SYN-PI-PRICE", role: "accountant", patientScope: "all", grants: { "finance.discounts.apply": true, "finance.price-increases.apply": true } },
  viewer: { username: "SYN-PI-VIEW", role: "accountant", patientScope: "all", grants: { "clinical.plans.view": true, "finance.invoices.view": true } },
  label: { username: "SYN-PI-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-PI-DR", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serviceId = 0, serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN PI patient',$2) RETURNING id", [`SYN-PI-${++serial}`, doctor]))[0].id as number;
async function plan(patientId: number, currency: "YER" | "SAR" = "YER", installments: { number: number; dueDate: string; amountMinor: number }[] = []) {
  const id = await db.createPlan({ patientId, title: "SYN PI plan", totalMinor: currency === "YER" ? 0 : 30000, baseCurrency: currency, startDate: "2026-11-01",
    note: null, createdBy: "SYN-PI-OWNER", installments });
  if (!id) throw new Error("SYN plan missing");
  return id;
}
const item = (extra: Record<string, unknown> = {}) => ({ serviceId, quantity: 1, toothCode: null, surfaces: null, note: null, billingRule: "on_completion" as const,
  doctorId: null, price: undefined as unknown, priceReason: null as string | null, ...extra });
const itemsOf = async (planId: number) => q("SELECT id, unit_price_minor::int AS price FROM plan_items WHERE plan_id=$1 ORDER BY id", [planId]);
const audits = async (action: string, planId: number) => (await q("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text ORDER BY id", [action, planId])).map(row => row.actor);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await q("INSERT INTO settings(key,value) VALUES('billing.max_discount_percent','10') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  db.invalidateSettingsCache();
  serviceId = (await q("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES ('SYN PI crown','crown',20000,10000,TRUE,TRUE) RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("plan items", () => {
  it("a base-currency plan takes the catalogue price; the item audit commits with the item", async () => {
    const p = await plan(await patient());
    expect(await items.commandCanonicalPlanItemAdd(await fx.session("editor"), p, item({ price: "1" }))).toEqual({ totalMinor: 20000 });
    expect(await itemsOf(p)).toEqual([{ id: expect.any(Number), price: 20000 }]);
    expect(await audits("plan.item_add", p)).toEqual(["SYN-PI-EDIT"]);
    expect(await audits("plan.price_override", p)).toEqual([]);
  });

  it("an agreement-currency price by the price grants: within the ceiling, beyond it, above the catalogue", async () => {
    const p = await plan(await patient(), "SAR");
    const priced = (price: string) => item({ price, priceReason: "SYN reason" });
    expect(await refusal(items.commandCanonicalPlanItemAdd(await fx.session("editor"), p, item()))).toMatchObject({ code: "price_required", status: 400 });
    expect(await refusal(items.commandCanonicalPlanItemAdd(await fx.session("editor"), p, priced("95")))).toMatchObject({ code: "price_authority", status: 400 });
    expect(await items.commandCanonicalPlanItemAdd(await fx.session("discounter"), p, priced("95"))).toMatchObject({ totalMinor: expect.any(Number) });
    expect(await refusal(items.commandCanonicalPlanItemAdd(await fx.session("discounter"), p, priced("80")))).toMatchObject({ code: "price_authority" });
    expect(await items.commandCanonicalPlanItemAdd(await fx.session("overrider"), p, priced("80"))).toMatchObject({ totalMinor: expect.any(Number) });
    expect(await refusal(items.commandCanonicalPlanItemAdd(await fx.session("editor"), p, priced("110")))).toMatchObject({ code: "price_authority" });
    expect(await items.commandCanonicalPlanItemAdd(await fx.session("raiser"), p, priced("110"))).toMatchObject({ totalMinor: expect.any(Number) });
    expect((await itemsOf(p)).map(row => row.price)).toEqual([9500, 8000, 11000]);
    expect(await audits("plan.price_override", p)).toEqual(["SYN-PI-DISC", "SYN-PI-OVER", "SYN-PI-RAISE"]);
  });

  it("update and delete keep their legacy guards: delete only before consent", async () => {
    const p = await plan(await patient()), session = await fx.session("editor");
    await items.commandCanonicalPlanItemAdd(session, p, item());
    await items.commandCanonicalPlanItemAdd(session, p, item());
    const [first, second] = await itemsOf(p);
    expect(await items.commandCanonicalPlanItemUpdate(session, p, { itemId: first.id, sessionCount: 3, note: "SYN layout" })).toEqual({ ok: true });
    expect((await q("SELECT session_count, note FROM plan_items WHERE id=$1", [first.id]))[0]).toEqual({ session_count: 3, note: "SYN layout" });
    expect(await items.commandCanonicalPlanItemRemove(session, p, second.id)).toEqual({ ok: true });
    expect(await refusal(items.commandCanonicalPlanItemRemove(session, p, 2_000_000_000))).toMatchObject({ code: "plan_refused", status: 409 });
    await items.commandCanonicalPlanConsent(session, p, null, null);
    expect(await refusal(items.commandCanonicalPlanItemRemove(session, p, first.id))).toMatchObject({ code: "plan_refused", status: 409 });
    expect(await itemsOf(p)).toHaveLength(1);
  });

  it("view grants, price grants alone and the label never write; outside reads like missing; revocation", async () => {
    const outside = await plan(await patient()), mine = await plan(await patient(fx.parties.doctor!));
    for (const key of ["viewer", "pricer", "label"] as const) {
      expect(await refusal(items.commandCanonicalPlanItemAdd(await fx.session(key), outside, item())), key).toMatchObject(denied);
    }
    const doctor = await fx.session("doctor");
    const outsideRefusal = await refusal(items.commandCanonicalPlanItemAdd(doctor, outside, item()));
    const missingRefusal = await refusal(items.commandCanonicalPlanItemAdd(doctor, 2_000_000_000, item()));
    expect(outsideRefusal).toMatchObject({ code: "plan_not_found", status: 404 });
    expect({ code: outsideRefusal?.code, message: outsideRefusal?.message }).toEqual({ code: missingRefusal?.code, message: missingRefusal?.message });
    expect(await refusal(items.commandCanonicalPlanConsent(doctor, outside, null, null))).toMatchObject({ code: "plan_not_found", status: 404 });
    expect(await items.commandCanonicalPlanItemAdd(doctor, mine, item())).toEqual({ totalMinor: 20000 });
    await fx.setGrants("editor", {}, { patientScope: "all" });
    try { expect(await refusal(items.commandCanonicalPlanItemAdd(await fx.session("editor"), outside, item()))).toMatchObject(denied); }
    finally { await fx.setGrants("editor", EDIT, { patientScope: "all" }); }
    expect(await itemsOf(outside)).toEqual([]);
  });

  it("does not reveal an external item's financial lineage by its identifier", async () => {
    // All patients, accounts, identifiers and invoices in this fixture are synthetic.
    const minePatient = await patient(fx.parties.doctor!), foreignPatient = await patient();
    const mine = await plan(minePatient), foreign = await plan(foreignPatient);
    const owner = await fx.session("owner"), doctor = await fx.session("doctor");
    await items.commandCanonicalPlanItemAdd(owner, foreign, item());
    await items.commandCanonicalPlanItemAdd(owner, foreign, item());
    await items.commandCanonicalPlanItemAdd(doctor, mine, item());
    await items.commandCanonicalPlanItemAdd(doctor, mine, item());
    const [foreignBilled, foreignOpen] = await itemsOf(foreign);
    const [mineBilled, mineOpen] = await itemsOf(mine);

    // Create a saved financial lineage without payments or any external service connection.
    async function addSyntheticInvoiceLine(patientId: number, itemId: number) {
      const [invoice] = await q(
        "INSERT INTO invoices(invoice_number,patient_id,created_by) VALUES ($1,$2,$3) RETURNING id",
        ["SYN-PI-SCOPE-" + (++serial), patientId, "SYN-PI-OWNER"],
      );
      await q(
        "INSERT INTO invoice_items(invoice_id,service_id,description,quantity,unit_price_minor,total_minor,plan_item_id) " +
        "SELECT $1,i.service_id,i.service_name,i.quantity,i.unit_price_minor,i.quantity*i.unit_price_minor,i.id FROM plan_items i WHERE i.id=$2",
        [invoice.id, itemId],
      );
    }
    await addSyntheticInvoiceLine(foreignPatient, foreignBilled.id);
    await addSyntheticInvoiceLine(minePatient, mineBilled.id);

    const missing = await refusal(items.commandCanonicalPlanItemRemove(doctor, mine, 2_000_000_000));
    const foreignFinancial = await refusal(items.commandCanonicalPlanItemRemove(doctor, mine, foreignBilled.id));
    const foreignUnbilled = await refusal(items.commandCanonicalPlanItemRemove(doctor, mine, foreignOpen.id));
    expect(missing).toMatchObject({ code: "plan_refused", status: 409 });
    for (const response of [foreignFinancial, foreignUnbilled]) {
      expect({ code: response?.code, status: response?.status, message: response?.message })
        .toEqual({ code: missing?.code, status: missing?.status, message: missing?.message });
    }

    // Preserves the financial guard inside the permitted plan; normal deletion still works.
    expect(await refusal(items.commandCanonicalPlanItemRemove(doctor, mine, mineBilled.id)))
      .toMatchObject({ code: "plan_refused", status: 409, message: expect.stringContaining("سجل مالي") });
    expect(await items.commandCanonicalPlanItemRemove(doctor, mine, mineOpen.id)).toEqual({ ok: true });
    expect(await refusal(items.commandCanonicalPlanItemRemove(doctor, foreign, foreignOpen.id)))
      .toMatchObject({ code: "plan_not_found", status: 404 });
    expect(await refusal(items.commandCanonicalPlanItemRemove(await fx.session("viewer"), mine, mineBilled.id)))
      .toMatchObject(denied);
    expect(await itemsOf(foreign)).toEqual([foreignBilled, foreignOpen]);
    expect(await itemsOf(mine)).toEqual([mineBilled]);
    expect(await audits("plan.item_remove", foreign)).toEqual([]);
  });

  it("refuses a patient that leaves the clinician's scope while the writer waits for the patient row", async () => {
    const pid = await patient(fx.parties.doctor!), p = await plan(pid), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [pid]);
      pending = refusal(items.commandCanonicalPlanItemAdd(session, p, item()));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id = $1 FOR NO KEY UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "plan_not_found", status: 404 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await itemsOf(p)).toEqual([]);
    expect(await audits("plan.item_add", p)).toEqual([]);
  });
});

describe("consent", () => {
  it("records the consent with its schedule in one operation", async () => {
    const p = await plan(await patient(), "SAR");
    expect(await items.commandCanonicalPlanConsent(await fx.session("editor"), p, "SYN consent", { count: 3, everyDays: 30, firstDueDate: "2026-12-01" }))
      .toEqual({ kind: "consented", totalMinor: 30000, installments: 3 });
    expect((await q("SELECT consent_by FROM treatment_plans WHERE id=$1", [p]))[0]).toEqual({ consent_by: "SYN-PI-EDIT" });
    expect(await q("SELECT number FROM plan_installments WHERE plan_id=$1 ORDER BY number", [p])).toHaveLength(3);
  });

  it("a schedule refusal keeps the consent and undoes only the schedule, as legacy", async () => {
    const p = await plan(await patient(), "SAR", [{ number: 1, dueDate: "2026-12-01", amountMinor: 30000 }]);
    expect(await items.commandCanonicalPlanConsent(await fx.session("editor"), p, null, { count: 2, everyDays: 30, firstDueDate: "2026-12-01" }))
      .toEqual({ kind: "schedule_refused", message: expect.stringContaining("سُجّلت الموافقة، وتعذّرت الجدولة") });
    expect((await q("SELECT consent_at IS NOT NULL AS consented FROM treatment_plans WHERE id=$1", [p]))[0]).toEqual({ consented: true });
    expect(await q("SELECT number FROM plan_installments WHERE plan_id=$1", [p])).toHaveLength(1);
  });
});
