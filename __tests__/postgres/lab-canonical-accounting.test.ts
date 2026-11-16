/** M2 slice 71: canonical lab-order accounting (PATCH /api/lab/[id] update_accounting,
 * post, unpost) on real PostgreSQL, synthetic data only. finance.payables.record inside
 * the patient scope; the legacy writer's guards unchanged (settlement, period lock, link,
 * currency); amounts in the response only with finance.cost-prices.view (owner rule);
 * revocation and concurrency. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-accounting-2026");
const db = await import("../../lib/db");
const acct = await import("../../lib/canonical-lab-accounting");

const PAY = { "clinical.lab.view": true, "finance.payables.record": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-LA-OWNER", role: "admin" },
  accountant: { username: "SYN-LA-ACC", role: "accountant", patientScope: "all", grants: { ...PAY } },
  accountantCost: { username: "SYN-LA-ACCC", role: "accountant", patientScope: "all", grants: { ...PAY, "finance.cost-prices.view": true } },
  doctorFin: { username: "SYN-LA-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { ...PAY } },
  noScope: { username: "SYN-LA-NOSCOPE", role: "accountant", grants: { ...PAY } },
  labOnly: { username: "SYN-LA-LAB", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const ctx = { mine: 0, theirs: 0, lab: 0 };
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);

/** A sent order with a saved cost and its payable (as receipt would have created it). */
async function order(patient: "mine" | "theirs" = "theirs", withPayable = true): Promise<number> {
  const id = (await q(`INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,sent_date,due_date,cost_minor,cost_currency,exchange_rate,base_amount_minor,is_posted,financial_status)
    VALUES ($1,$2,'SYN Acct Lab','Synthetic crown','sent','2031-01-01','2031-01-10',30000,'YER',1,30000,TRUE,'pending_delivery') RETURNING id`, [ctx[patient], ctx.lab]))[0].id as number;
  if (withPayable) {
    const payable = (await q(`INSERT INTO payables(party_id,category,description,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,lab_order_id,due_date,created_by,is_posted)
      VALUES ($1,'lab','Synthetic crown',30000,'YER',1,30000,'YER',$2,'2031-01-10','synthetic',TRUE) RETURNING id`, [ctx.lab, id]))[0].id;
    await q("UPDATE lab_orders SET payable_id=$1, financial_status='payable_created' WHERE id=$2", [payable, id]);
  }
  return id;
}
const state = async (id: number) => (await q(`SELECT l.is_posted, l.financial_status, l.cost_minor::int AS cost, p.amount_minor::int AS payable, p.is_posted AS payable_posted
  FROM lab_orders l LEFT JOIN payables p ON p.id = l.payable_id WHERE l.id=$1`, [id]))[0];
const audits = async (id: number) => (await q("SELECT actor FROM audit_log WHERE action='lab_order.accounting' AND entity_id=$1::text ORDER BY id", [id])).map(row => row.actor);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000990',$3) RETURNING id", [number, `SYN Acct ${number}`, doctor]))[0].id as number;
  ctx.mine = await patient("SYN-LA-1", fx.parties.doctorFin!);
  ctx.theirs = await patient("SYN-LA-2", null);
  ctx.lab = (await q("INSERT INTO parties(name,kind,currency) VALUES('SYN Acct Lab','lab','YER') RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("posting and cost", () => {
  it("unpost then post move the order and its payable together; tracking and audit carry the admitted actor; amounts only with cost view", async () => {
    const id = await order();
    const unposted = await acct.commandCanonicalLabAccounting(await fx.session("accountant"), String(id), { action: "unpost" });
    expect(unposted).toMatchObject({ outcome: "updated", projection: { costs: false } });
    expect(unposted.order).not.toHaveProperty("costMinor");
    expect(JSON.stringify(unposted)).not.toContain("30000");
    expect(await state(id)).toMatchObject({ is_posted: false, financial_status: "pending_post", payable_posted: false });
    const posted = await acct.commandCanonicalLabAccounting(await fx.session("accountantCost"), String(id), { action: "post" });
    expect(posted).toMatchObject({ projection: { costs: true }, order: { costMinor: 30000 } });
    expect(await state(id)).toMatchObject({ is_posted: true, financial_status: "payable_created", payable_posted: true });
    expect(await audits(id)).toEqual(["SYN-LA-ACC", "SYN-LA-ACCC"]);
    expect((await q("SELECT action, actor FROM lab_order_tracking WHERE lab_order_id=$1 ORDER BY id", [id])).map(row => `${row.action}:${row.actor}`))
      .toEqual(["accounting_updated:SYN-LA-ACC", "accounting_posted:SYN-LA-ACCC"]);
  });
  it("a cost change updates the order and its payable together; an exact repeat writes nothing", async () => {
    const id = await order();
    const input = { action: "update_accounting", cost: "450", costCurrency: "YER" };
    expect((await acct.commandCanonicalLabAccounting(await fx.session("accountant"), String(id), input)).outcome).toBe("updated");
    // YER has no minor-unit subdivision here: "450" is 450.
    expect(await state(id)).toMatchObject({ cost: 450, payable: 450 });
    expect((await acct.commandCanonicalLabAccounting(await fx.session("accountant"), String(id), input)).outcome).toBe("unchanged");
    expect(await audits(id)).toHaveLength(1);
  });
  it("refuses a cost without its currency, and a cleared obligation, without writing", async () => {
    const id = await order();
    expect(await refusal(acct.commandCanonicalLabAccounting(await fx.session("accountant"), String(id), { action: "update_accounting", cost: "450" })))
      .toMatchObject({ code: "lab_accounting_currency_required", status: 400 });
    expect(await refusal(acct.commandCanonicalLabAccounting(await fx.session("accountant"), String(id), { action: "update_accounting", cost: "" }))).not.toBeNull();
    expect(await state(id)).toMatchObject({ cost: 30000, payable: 30000 });
    expect(await audits(id)).toEqual([]);
  });
});

describe("financial guards (legacy writer, unchanged)", () => {
  it("settled work and a locked period are refused without writing", async () => {
    const settled = await order();
    await q("INSERT INTO lab_order_tracking(lab_order_id,action,actor) VALUES ($1,'financial_settlement','synthetic')", [settled]);
    expect(await refusal(acct.commandCanonicalLabAccounting(await fx.session("accountant"), String(settled), { action: "unpost" })))
      .toMatchObject({ code: "lab_order_accounting_settled", status: 409 });
    const locked = await order();
    await q("INSERT INTO settings(key,value) VALUES ('finance.locked_before','2031-06-01') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    try {
      expect(await refusal(acct.commandCanonicalLabAccounting(await fx.session("accountant"), String(locked), { action: "unpost" })))
        .toMatchObject({ code: "lab_order_accounting_period_locked", status: 409 });
    } finally { await q("DELETE FROM settings WHERE key='finance.locked_before'"); }
    expect([await state(settled), await state(locked)].map(row => row.is_posted)).toEqual([true, true]);
  });
  it("two concurrent cost edits leave the order and its payable consistent", async () => {
    const id = await order();
    const results = await Promise.allSettled([
      acct.commandCanonicalLabAccounting(await fx.session("accountant"), String(id), { action: "update_accounting", cost: "500", costCurrency: "YER" }),
      acct.commandCanonicalLabAccounting(await fx.session("accountantCost"), String(id), { action: "update_accounting", cost: "600", costCurrency: "YER" }),
    ]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    for (const result of results) if (result.status === "rejected") expect((result.reason as { code?: string }).code).toBe("lab_order_accounting_busy");
    const final = await state(id);
    expect(final.cost).toBe(final.payable);
    expect([500, 600]).toContain(final.cost);
    expect((await audits(id)).length).toBe(results.filter(result => result.status === "fulfilled").length);
  });
});

describe("authority", () => {
  it("needs finance.payables.record and the patient scope; another patient reads as missing; revocation refuses", async () => {
    const mine = await order("mine"), theirs = await order();
    const doctor = await fx.session("doctorFin");
    expect((await acct.commandCanonicalLabAccounting(doctor, String(mine), { action: "unpost" })).outcome).toBe("updated");
    expect(await refusal(acct.commandCanonicalLabAccounting(doctor, String(theirs), { action: "unpost" }))).toMatchObject({ code: "lab_order_not_found", status: 404 });
    await expect(acct.commandCanonicalLabAccounting(await fx.session("noScope"), String(theirs), { action: "unpost" })).rejects.toThrow("RECORD_SCOPE_DENIED");
    await expect(acct.commandCanonicalLabAccounting(await fx.session("labOnly"), String(theirs), { action: "unpost" })).rejects.toThrow("CAPABILITY_DENIED");
    const issued = await fx.session("accountant");
    await fx.setGrants("accountant", { "clinical.lab.view": true }, { patientScope: "all" });
    try {
      await expect(acct.commandCanonicalLabAccounting(issued, String(theirs), { action: "unpost" })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("accountant", { ...PAY }, { patientScope: "all" }); }
    expect(await state(theirs)).toMatchObject({ is_posted: true });
  });
});
