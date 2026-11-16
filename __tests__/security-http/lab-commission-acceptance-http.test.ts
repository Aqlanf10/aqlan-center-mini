/** Owner acceptance #483 6886062729 on the built application (real HTTP, shared synthetic database): a crown
 * invoice created directly — no visit first — opens one lab order; the lab's cost is entered on the order;
 * the commission the finance screen reads is taken after that cost. Invoice 1000, lab 200, doctor 30%. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const ids = { patient: 0, doctor: 0, lab: 0, service: 0, invoice: 0, order: 0 };
const one = async <T,>(sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0] as T;
const row = async () => {
  const report = await (await authedGet("/api/finance/commissions?from=2020-01-01&to=2999-12-31", h.sessions.admin)).json() as
    { rows: { doctorId: number; currency: string; accruedMinor: number; earnedMinor: number; labCostMinor: number; labCostNotDeductedCount: number }[] };
  return report.rows.find(r => r.doctorId === ids.doctor && r.currency === "YER");
};

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const tag = randomUUID().slice(0, 8);
  ids.patient = (await one<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN lab acceptance patient') RETURNING id", [`SYN-LCA-${tag}`])).id;
  ids.doctor = (await one<{ id: number }>("INSERT INTO parties(name,kind,commission_percent) VALUES($1,'doctor',30) RETURNING id", [`SYN lab acceptance doctor ${tag}`])).id;
  ids.lab = (await one<{ id: number }>("INSERT INTO parties(name,kind,currency) VALUES($1,'lab','YER') RETURNING id", [`SYN acceptance lab ${tag}`])).id;
  ids.service = (await one<{ id: number }>("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,'crown',1000,TRUE,TRUE) RETURNING id", [`SYN acceptance crown ${tag}`])).id;
}, 240_000);
afterAll(async () => { await db?.end(); });

describe("crown invoice → lab order → lab cost → commission, over HTTP", () => {
  it("a direct invoice with a lab prescription opens one unpriced order: no payable, commission on the full 1000", async () => {
    const labWork = { intentId: randomUUID(), memberId: randomUUID(), expectedRevision: 0, groupKind: "single",
      prescription: { partyId: ids.lab, shade: "A2", stumpShade: "", toothNumbers: "", dueDate: "2026-12-01", impressionType: "physical", priority: "normal" } };
    const created = await authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify({ patientId: ids.patient, currency: "YER", idempotencyKey: `lca-http-${randomUUID()}`,
      items: [{ serviceId: ids.service, doctorId: ids.doctor, quantity: 1, price: "1000", sessions: 1, toothCode: 27, episodeTeeth: [27], labWork }] }));
    expect(created.status, await created.clone().text()).toBe(201);
    ids.invoice = (await created.json()).id;
    const orders = (await db.query<{ id: number; visit_id: number | null; shade: string | null; cost_minor: string | null; payable_id: number | null }>(
      "SELECT id, visit_id, shade, cost_minor, payable_id FROM lab_orders WHERE patient_id=$1", [ids.patient])).rows;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ visit_id: null, shade: "A2", cost_minor: null, payable_id: null });
    ids.order = orders[0].id;
    expect(await row()).toMatchObject({ accruedMinor: 300, labCostMinor: 0 });
  });

  it("entering the lab's cost of 200 creates one payable; the commission becomes 240; saving it again changes nothing", async () => {
    const cost = () => authedMutation(`/api/lab/${ids.order}`, h.sessions.admin, "PATCH", JSON.stringify({ action: "update_accounting", cost: "200", costCurrency: "YER" }));
    expect((await cost()).status).toBe(200);
    expect((await cost()).status).toBe(200);
    expect((await db.query("SELECT amount_minor::int AS amount, currency FROM payables WHERE lab_order_id=$1", [ids.order])).rows).toEqual([{ amount: 200, currency: "YER" }]);
    expect(await row()).toMatchObject({ accruedMinor: 240, labCostMinor: 200, labCostNotDeductedCount: 0 });
  });

  it("a foreign lab cost is never converted silently: it is reported as not deducted and the commission returns to 300", async () => {
    const foreign = await authedMutation(`/api/lab/${ids.order}`, h.sessions.admin, "PATCH", JSON.stringify({ action: "update_accounting", cost: "2", costCurrency: "SAR" }));
    expect(foreign.status, await foreign.clone().text()).toBe(200);
    expect(await row()).toMatchObject({ accruedMinor: 300, labCostMinor: 0, labCostNotDeductedCount: 1 });
    // The allowed remedy is to record the cost in the invoice's currency; the single payable follows it.
    expect((await authedMutation(`/api/lab/${ids.order}`, h.sessions.admin, "PATCH", JSON.stringify({ action: "update_accounting", cost: "200", costCurrency: "YER" }))).status).toBe(200);
    expect(await row()).toMatchObject({ accruedMinor: 240, labCostMinor: 200, labCostNotDeductedCount: 0 });
    expect((await db.query("SELECT amount_minor::int AS amount, currency FROM payables WHERE lab_order_id=$1", [ids.order])).rows).toEqual([{ amount: 200, currency: "YER" }]);
  });
});
